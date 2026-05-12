import { CommandPolyfillService } from '@/polyfill/CommandPolyfillService';
import { CommandExecutionError, ConnectionError, FeatureNotSupportedError } from '../../errors';
import type {
  Endpoint,
  ExecuteOptions,
  ExecuteResult,
  ImageSpec,
  KubeAccessPolicy,
  LabelSpec,
  LifecyclePolicy,
  SandboxEndpointSelector,
  SandboxId,
  SandboxInfo,
  SandboxProxyService,
  SandboxProxyTarget,
  SandboxState
} from '../../types';
import { BaseSandboxAdapter } from '../BaseSandboxAdapter';
import { DevboxApi } from './api';
import { DevboxPhaseEnum, type DevboxCreateRequest, type DevboxInfoData } from './type';
import { SEALOS_DEVBOX_CODE_SERVER_PORT } from '../ports';
import { formatImageSpec, parseImageSpec } from '@/utils/image';
import { joinUrlPath, normalizePathPrefix } from '@/utils/url';

/**
 * Configuration for Sealos Devbox Adapter.
 */
export interface SealosDevboxConfig {
  /** Base URL for the Sealos Devbox Server API */
  baseUrl: string;
  /** JWT authentication token */
  token: string;
  sandboxId: string;
  /**
   * Optional override for the Sealos httpgate wildcard domain. When omitted,
   * it is derived from gateway.url returned by Devbox Server.
   */
  httpgateDomain?: string;
}

export interface SealosDevboxCreateConfig {
  image?: ImageSpec;
  env?: Record<string, string>;
  labels?: LabelSpec[];
  upstreamID?: string;
  kubeAccess?: KubeAccessPolicy;
  lifecycle?: LifecyclePolicy;
  workingDir?: string;
}

export class SealosDevboxAdapter extends BaseSandboxAdapter {
  readonly provider = 'sealosdevbox' as const;

  get rootPath(): string {
    return '/home/devbox/workspace';
  }

  private api: DevboxApi;
  private _id: SandboxId;

  constructor(
    private config: SealosDevboxConfig,
    private createConfig?: SealosDevboxCreateConfig
  ) {
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

  private buildCreateRequest(): DevboxCreateRequest {
    const spec = this.createConfig ?? {};
    const env = { ...(spec.env ?? {}) };
    if (spec.workingDir && !env.CODEX_GATEWAY_CWD) {
      env.CODEX_GATEWAY_CWD = spec.workingDir;
    }

    return this.removeUndefined({
      name: this._id,
      image: spec.image ? formatImageSpec(spec.image) : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      labels: spec.labels,
      upstreamID: spec.upstreamID,
      kubeAccess: spec.kubeAccess,
      pauseAt: spec.lifecycle?.pauseAt,
      archiveAfterPauseTime: spec.lifecycle?.archiveAfterPauseTime
    });
  }

  private removeUndefined<T extends Record<string, unknown>>(obj: T): T {
    return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
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
        image: parseImageSpec(data.image),
        entrypoint: [],
        status: this._status,
        createdAt: data.creationTimestamp ? new Date(data.creationTimestamp) : new Date()
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
      const res = await this.api.create(this.buildCreateRequest());
      if (res.code !== 200 && res.code !== 201) {
        throw new Error(res.message || `Devbox create failed with code ${res.code}`);
      }
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
      await this.api.stop(this._id);
      this._status = { state: 'Stopped' };
    } catch (error) {
      throw new CommandExecutionError(
        'Failed to stop sandbox',
        'stop',
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

  async getEndpoint(selector: SandboxEndpointSelector): Promise<Endpoint> {
    const port = typeof selector === 'number' ? selector : SEALOS_DEVBOX_CODE_SERVER_PORT;
    const target = await this.getHttpgateTarget(port);

    if (selector === 'code-server') {
      await this.waitForCodeServerHealthz(target);
    }

    const url = new URL(target.origin);

    return {
      host: url.host,
      port: target.port,
      protocol: url.protocol === 'https:' ? 'https' : 'http',
      url: joinUrlPath(target.origin, target.basePath)
    };
  }

  async getProxyTarget(service: SandboxProxyService = 'code-server'): Promise<SandboxProxyTarget> {
    if (service !== 'code-server') {
      throw new FeatureNotSupportedError(
        `Proxy service "${service}" is not supported by this provider`,
        'getProxyTarget',
        this.provider
      );
    }

    const target = await this.getHttpgateTarget(SEALOS_DEVBOX_CODE_SERVER_PORT);
    return {
      service,
      origin: target.origin,
      basePath: target.basePath,
      auth: 'code-server',
      ...(target.password ? { password: target.password } : {})
    };
  }

  private async waitForCodeServerHealthz(target: {
    origin: string;
    basePath: string;
  }): Promise<void> {
    const healthUrl = joinUrlPath(joinUrlPath(target.origin, target.basePath), '/healthz');
    const timeoutMs = 60_000;
    const intervalMs = 500;
    const requestTimeoutMs = 3_000;
    const deadline = Date.now() + timeoutMs;
    let lastResult = 'not checked';

    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(requestTimeoutMs)
        });

        if (res.status >= 200 && res.status < 400) {
          return;
        }

        lastResult = `status ${res.status}`;
      } catch (error) {
        lastResult = error instanceof Error ? error.message : String(error);
      }

      await this.sleep(intervalMs);
    }

    throw new ConnectionError(
      `Devbox code-server health check ${healthUrl} did not become ready within ${timeoutMs}ms. Last result: ${lastResult}`,
      this.config.baseUrl
    );
  }

  private async getHttpgateTarget(
    port: number
  ): Promise<{ origin: string; basePath: string; port: number; password?: string }> {
    const res = await this.api.info(this._id);
    if (res.code !== 200 || !res.data) {
      throw new ConnectionError(`Failed to get devbox info: ${res.message}`, this.config.baseUrl);
    }

    if (port === SEALOS_DEVBOX_CODE_SERVER_PORT) {
      const gateway = res.data.codeServerGateway;
      if (!gateway?.url) {
        throw new ConnectionError(
          'Devbox info does not include codeServerGateway.url; cannot resolve code-server endpoint',
          this.config.baseUrl
        );
      }

      const codeServerUrl = new URL(gateway.url);
      return {
        origin: codeServerUrl.origin,
        basePath: normalizePathPrefix(codeServerUrl.pathname),
        port: gateway.port ?? port,
        password: gateway.password
      };
    }

    const gatewayUrl = res.data.gateway?.url;
    if (!gatewayUrl) {
      throw new ConnectionError(
        'Devbox info does not include gateway.url; cannot derive httpgate endpoint',
        this.config.baseUrl
      );
    }

    const gateway = new URL(gatewayUrl);
    const uniqueID = this.getGatewayUniqueID(res.data, gateway);
    const domain = this.getHttpgateDomain(gateway);
    return {
      origin: `${gateway.protocol}//devbox-${uniqueID}-${port}.${domain}`,
      basePath: '',
      port
    };
  }

  private getGatewayUniqueID(data: DevboxInfoData, gateway: URL): string {
    if (data.gateway?.uniqueID) return data.gateway.uniqueID;

    const parts = gateway.pathname.split('/').filter(Boolean);
    const uniqueID = parts[parts.length - 1];
    if (!uniqueID) {
      throw new ConnectionError(
        'Devbox gateway.url does not include uniqueID; cannot derive httpgate endpoint',
        this.config.baseUrl
      );
    }
    return uniqueID;
  }

  private getHttpgateDomain(gateway: URL): string {
    if (this.config.httpgateDomain) {
      return this.normalizeHttpgateDomain(this.config.httpgateDomain);
    }

    const prefix = 'devbox-gateway.';
    if (!gateway.host.startsWith(prefix)) {
      throw new ConnectionError(
        `Cannot derive httpgate domain from gateway host "${gateway.host}"`,
        this.config.baseUrl
      );
    }

    return gateway.host.slice(prefix.length);
  }

  private normalizeHttpgateDomain(domain: string): string {
    const trimmed = domain.trim().replace(/^\.+|\.+$/g, '');
    if (!trimmed) {
      throw new ConnectionError('httpgateDomain is empty', this.config.baseUrl);
    }
    if (trimmed.includes('://')) {
      return new URL(trimmed).host;
    }
    return trimmed;
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
      if (!res.data) return false;

      return res.data.state.phase === DevboxPhaseEnum.Running;
    } catch {
      return false;
    }
  }
}
