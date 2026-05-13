import { afterEach, describe, expect, it, vi } from 'vitest';
import { SealosDevboxAdapter, type SealosDevboxConfig } from '@/adapters/SealosDevboxAdapter';

const CONFIG: SealosDevboxConfig = {
  baseUrl: 'https://devbox-server.example.com',
  token: 'test-token',
  sandboxId: 'devbox-1'
};

const createDevboxInfo = () => ({
  name: 'devbox-1',
  state: { phase: 'Running' },
  ssh: {},
  gateway: {
    url: 'https://devbox-gateway.staging-usw-1.sealos.io/codex/abc123',
    port: 1317,
    uniqueID: 'abc123'
  },
  codeServerGateway: {
    url: 'https://devbox-gateway.staging-usw-1.sealos.io/code-server/abc123',
    password: 'password',
    port: 1318,
    uniqueID: 'abc123'
  }
});

const createDevboxInfoResponse = (data = createDevboxInfo()) => ({
  json: async () => ({
    code: 200,
    message: 'ok',
    data
  })
});

describe('SealosDevboxAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('should map unified create spec into Devbox create request', () => {
    const adapter = new SealosDevboxAdapter(CONFIG, {
      image: { repository: 'runtime/fastgpt', tag: 'latest' },
      env: { CODE_SERVER_ENABLED: 'true' },
      workingDir: '/home/devbox/workspace',
      upstreamID: 'session-1',
      labels: [
        { key: 'teamId', value: 'team-1' },
        { key: 'sessionId', value: 'session-1' }
      ],
      kubeAccess: { enabled: true, roleTemplate: 'edit' },
      lifecycle: {
        pauseAt: '2026-05-08T10:00:00Z',
        archiveAfterPauseTime: '1h'
      }
    });

    const request = (
      adapter as unknown as { buildCreateRequest(): Record<string, unknown> }
    ).buildCreateRequest();

    expect(request).toEqual({
      name: 'devbox-1',
      image: 'runtime/fastgpt:latest',
      env: {
        CODE_SERVER_ENABLED: 'true',
        CODEX_GATEWAY_CWD: '/home/devbox/workspace'
      },
      upstreamID: 'session-1',
      labels: [
        { key: 'teamId', value: 'team-1' },
        { key: 'sessionId', value: 'session-1' }
      ],
      kubeAccess: { enabled: true, roleTemplate: 'edit' },
      pauseAt: '2026-05-08T10:00:00Z',
      archiveAfterPauseTime: '1h'
    });
  });

  it('should require codeServerGateway url for code-server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          code: 200,
          message: 'ok',
          data: {
            name: 'devbox-1',
            state: { phase: 'Running' },
            ssh: {},
            gateway: {
              url: 'https://devbox-gateway.staging-usw-1.sealos.io/codex/abc123'
            }
          }
        })
      }))
    );

    const adapter = new SealosDevboxAdapter(CONFIG);

    await expect(adapter.getEndpoint('code-server')).rejects.toThrow('codeServerGateway.url');
    await expect(adapter.getProxyTarget('code-server')).rejects.toThrow('codeServerGateway.url');
  });

  it('should prefer codeServerGateway url from Devbox info', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/code-server/abc123/healthz')) {
        return { status: 200 };
      }

      return createDevboxInfoResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SealosDevboxAdapter(CONFIG);

    await expect(adapter.getEndpoint('code-server')).resolves.toEqual({
      host: 'devbox-gateway.staging-usw-1.sealos.io',
      port: 1318,
      protocol: 'https',
      url: 'https://devbox-gateway.staging-usw-1.sealos.io/code-server/abc123'
    });
    await expect(adapter.getProxyTarget('code-server')).resolves.toEqual({
      service: 'code-server',
      origin: 'https://devbox-gateway.staging-usw-1.sealos.io',
      basePath: '/code-server/abc123',
      password: 'password',
      auth: 'code-server'
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://devbox-gateway.staging-usw-1.sealos.io/code-server/abc123/healthz',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should retry code-server healthz until it is ready before returning endpoint', async () => {
    vi.useFakeTimers();
    let healthCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/code-server/abc123/healthz')) {
        healthCalls++;
        return { status: healthCalls === 1 ? 502 : 200 };
      }

      return createDevboxInfoResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SealosDevboxAdapter(CONFIG);
    const endpointPromise = adapter.getEndpoint('code-server');

    await vi.advanceTimersByTimeAsync(500);

    await expect(endpointPromise).resolves.toEqual({
      host: 'devbox-gateway.staging-usw-1.sealos.io',
      port: 1318,
      protocol: 'https',
      url: 'https://devbox-gateway.staging-usw-1.sealos.io/code-server/abc123'
    });
    expect(healthCalls).toBe(2);
  });

  it('should fail when code-server healthz does not become ready', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/code-server/abc123/healthz')) {
        return { status: 502 };
      }

      return createDevboxInfoResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SealosDevboxAdapter(CONFIG);
    const endpointPromise = adapter.getEndpoint('code-server');
    const expectation = expect(endpointPromise).rejects.toThrow(
      'Devbox code-server health check https://devbox-gateway.staging-usw-1.sealos.io/code-server/abc123/healthz did not become ready within 60000ms. Last result: status 502'
    );

    await vi.advanceTimersByTimeAsync(60_500);

    await expectation;
  });

  it('should allow an explicit httpgate domain override for non-code-server endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          code: 200,
          message: 'ok',
          data: {
            name: 'devbox-1',
            state: { phase: 'Running' },
            ssh: {},
            gateway: {
              url: 'https://custom-gateway.example.net/codex/abc123',
              uniqueID: 'from-info'
            }
          }
        })
      }))
    );

    const adapter = new SealosDevboxAdapter({
      ...CONFIG,
      httpgateDomain: 'https://apps.example.net'
    });

    await expect(adapter.getEndpoint(1317)).resolves.toMatchObject({
      host: 'devbox-from-info-1317.apps.example.net',
      port: 1317,
      protocol: 'https',
      url: 'https://devbox-from-info-1317.apps.example.net'
    });
  });

  it('should accept Devbox create success code 201', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          code: 201,
          message: 'created',
          data: { name: 'devbox-1' }
        })
      })
      .mockResolvedValueOnce({
        json: async () => ({
          code: 200,
          message: 'ok',
          data: {
            name: 'devbox-1',
            state: { phase: 'Running' },
            ssh: {},
            gateway: {
              url: 'https://devbox-gateway.staging-usw-1.sealos.io/codex/abc123'
            }
          }
        })
      });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SealosDevboxAdapter(CONFIG);
    const createPromise = adapter.create();

    await vi.runAllTimersAsync();

    await expect(createPromise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should stop Devbox through the stop endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({
        code: 200,
        message: 'ok',
        data: {
          name: 'devbox-1',
          namespace: 'ns-test',
          state: 'Stopped'
        }
      })
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SealosDevboxAdapter(CONFIG);

    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.status.state).toBe('Stopped');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://devbox-server.example.com/api/v1/devbox/devbox-1/stop',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('should delete the provided Devbox id', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => ({
      json: async () => ({
        code: String(input).includes('/api/v1/devbox/provider-devbox-1') ? 404 : 200,
        message: 'ok',
        data: null
      })
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SealosDevboxAdapter(CONFIG);

    await expect(adapter.delete('provider-devbox-1')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://devbox-server.example.com/api/v1/devbox/provider-devbox-1',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(adapter.id).toBe('provider-devbox-1');
    expect(adapter.status.state).toBe('UnExist');
  });
});
