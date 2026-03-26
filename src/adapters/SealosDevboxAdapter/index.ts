import { CommandPolyfillService } from '@/polyfill/CommandPolyfillService';
import { CommandExecutionError, ConnectionError } from '../../errors';
import type {
  ExecuteOptions,
  ExecuteResult,
  SandboxId,
  SandboxInfo,
  SandboxState
} from '../../types';
import { BaseSandboxAdapter } from '../BaseSandboxAdapter';
import { DevboxApi } from './api';
import { DevboxPhaseEnum, type DevboxInfoData } from './type';

/**
 * Configuration for Sealos Devbox Adapter.
 */
export interface SealosDevboxConfig {
  /** Base URL for the Sealos Devbox Server API */
  baseUrl: string;
  /** JWT authentication token */
  token: string;
  sandboxId: string;
}

export class SealosDevboxAdapter extends BaseSandboxAdapter {
  readonly provider = 'sealosdevbox' as const;

  get rootPath(): string {
    return '/home/devbox/workspace';
  }

  private api: DevboxApi;
  private _id: SandboxId;

  constructor(private config: SealosDevboxConfig) {
    super();
    this.api = new DevboxApi({ baseUrl: config.baseUrl, token: config.token });
    this._id = config.sandboxId;
    this.polyfillService = new CommandPolyfillService(this);
  }

  get id(): SandboxId {
    return this._id;
  }

  private StatusAdapt(data: DevboxInfoData): SandboxState {
    if (data.deletionTimestamp) {
      return 'Deleting';
    }

    switch (data.state.phase) {
      case DevboxPhaseEnum.Running:
        return 'Running';
      case DevboxPhaseEnum.Pending:
        return 'Creating';
      case DevboxPhaseEnum.Paused:
        return 'Stopped';
      case DevboxPhaseEnum.Pausing:
        return 'Stopping';
      default:
        return 'Error';
    }
  }

  // ==================== Lifecycle Methods ====================

  async getInfo(): Promise<SandboxInfo | null> {
    try {
      const res = await this.api.info(this._id);
      if (res.code !== 200) return null;
      if (!res.data) return Promise.reject(res.message);

      const data: DevboxInfoData = res.data;

      this._status = { state: this.StatusAdapt(data), message: res.message };
      return {
        id: data.name,
        image: { repository: '' },
        entrypoint: [],
        status: this._status,
        createdAt: new Date()
      };
    } catch (error: any) {
      throw new CommandExecutionError(
        `Failed to get sandbox info`,
        'getInfo',
        error instanceof Error ? error : undefined
      );
    }
  }

  async ensureRunning(): Promise<void> {
    try {
      const sandbox = await this.getInfo();
      if (sandbox) {
        const status = sandbox.status.state;
        switch (status) {
          case 'Running':
            return;
          case 'Creating':
          case 'Starting':
            await this.waitUntilReady();
            return;
          case 'Stopping':
          case 'Stopped':
            await this.start();
            return;
          case 'Deleting':
            await this.waitUntilDeleted();
            await this.create();
            return;
          default:
            throw new ConnectionError(`Failed to ensure sandbox running`);
        }
      }

      // Not found, create sandbox
      await this.create();
    } catch (error: any) {
      throw new ConnectionError(`Failed to ensure sandbox running`, this.config.baseUrl, error);
    }
  }
  /*  
    创建可用沙盒
  */
  async create(): Promise<void> {
    try {
      this._status = { state: 'Creating' };
      await this.api.create(this._id);
      await this.waitUntilReady();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this._status = { state: 'Running' };
    } catch (error) {
      throw new ConnectionError('Failed to create sandbox', this.config.baseUrl, error);
    }
  }

  async stop(): Promise<void> {
    try {
      this._status = { state: 'Stopping' };
      await this.api.pause(this._id);
      this._status = { state: 'Stopped' };
    } catch (error) {
      throw new CommandExecutionError(
        'Failed to pause sandbox',
        'pause',
        error instanceof Error ? error : undefined
      );
    }
  }

  async start(): Promise<void> {
    try {
      this._status = { state: 'Starting' };
      await this.api.resume(this._id);
      await this.waitUntilReady();
      this._status = { state: 'Running' };
    } catch (error) {
      throw new CommandExecutionError(
        'Failed to resume sandbox',
        'resume',
        error instanceof Error ? error : undefined
      );
    }
  }

  async delete(): Promise<void> {
    try {
      this._status = { state: 'Deleting' };
      await this.api.delete(this._id);
      await this.waitUntilDeleted();
      this._status = { state: 'UnExist' };
    } catch (error) {
      throw new CommandExecutionError(
        'Failed to delete sandbox',
        'delete',
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==================== Command Execution ====================

  async execute(command: string, options?: ExecuteOptions): Promise<ExecuteResult> {
    const cmd = this.buildCommand(command, this.normalizePath(options?.workingDirectory));
    try {
      const res = await this.api.exec(this._id, {
        command: cmd,
        timeoutSeconds: options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined
      });

      if (!res.data) {
        throw new CommandExecutionError(`Command execution failed: ${res.message}`, command);
      }

      return {
        stdout: res.data.stdout,
        stderr: res.data.stderr,
        exitCode: res.data.exitCode
      };
    } catch (error: any) {
      throw new CommandExecutionError(
        `Command execution failed: ${error?.message || error?.code}`,
        command,
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==================== Health Check ====================

  /**
   * Check if the devbox is ready by querying info endpoint.
   * Ready when spec, status, and phase are all "Running".
   */
  async ping(): Promise<boolean> {
    try {
      const res = await this.api.info(this._id);
      if (res.code !== 200) return false;

      return res.data.state.phase === DevboxPhaseEnum.Running;
    } catch {
      return false;
    }
  }
}
