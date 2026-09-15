/**
 * The RabbitMQ management HTTP API, for what AMQP cannot do (integration spec, decisions 7 and 12
 * and the harness section): virtual hosts, permissions, `get` from a queue, a queue delete, the
 * alarm check, and the queue object of the existence check. Credentials travel in a `Basic` header,
 * never in the URL: `fetch` rejects a URL with userinfo and echoes it in the error. No queue metric
 * read here is ever a wait target (decision 13): the statistics lag by up to 5 s.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export type QueueInfo =
  { status: 404 } | { status: 200; messages: number | undefined; consumers: number | undefined };

/** One message of `POST /api/queues/{vhost}/{name}/get` with `encoding: 'auto'`. */
export type QueueMessage = {
  payload: string;
  payload_encoding: string;
  redelivered: boolean;
  properties: {
    message_id?: string;
    content_type?: string;
    delivery_mode?: number;
    timestamp?: number;
    headers?: Record<string, unknown>;
  };
};

/** The client scoped to one virtual host: what a test environment holds. */
export type ManagementApi = {
  /** The queue object, or 404 before the queue is declared; its metrics may be absent or stale. */
  queue(name: string): Promise<QueueInfo>;
  deleteQueue(name: string): Promise<void>;
  /** `ack_requeue_false`: the messages leave the queue. `count` is an upper bound the test derives from what it sent. */
  getMessages(name: string, count: number): Promise<QueueMessage[]>;
  /** 200 without an alarm in effect, 503 with one. */
  alarms(): Promise<number>;
};

export type ManagementClient = {
  createVhost(name: string): Promise<void>;
  deleteVhost(name: string): Promise<void>;
  /** `GET /api/vhosts/{name}`: 200 while the virtual host exists, 404 once it is deleted. */
  hasVhost(name: string): Promise<boolean>;
  grantAll(vhost: string, user: string): Promise<void>;
  vhost(name: string): ManagementApi;
};

type Call = {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  ok: readonly number[];
};

type Reply = { status: number; body: unknown };

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function createManagementClient({
  host,
  port,
  user,
  password,
}: {
  host: string;
  port: number;
  user: string;
  password: string;
}): ManagementClient {
  const base = `http://${host}:${String(port)}/api`;
  const authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
  const encode = encodeURIComponent;

  const call = async ({ method, path, body, ok }: Call): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // The body is always read, so the connection returns to the pool; it never goes into an error.
    const text = await response.text();
    if (!ok.includes(response.status)) {
      throw new Error(`management API ${method} ${path}: HTTP ${String(response.status)}`);
    }
    return {
      status: response.status,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
  };

  const vhost = (name: string): ManagementApi => {
    const queues = `/queues/${encode(name)}`;
    return {
      queue: async (queue) => {
        const reply = await call({
          method: 'GET',
          path: `${queues}/${encode(queue)}`,
          ok: [200, 404],
        });
        if (reply.status === 404) {
          return { status: 404 };
        }
        const object = reply.body as { messages?: unknown; consumers?: unknown };
        return {
          status: 200,
          messages: numberOrUndefined(object.messages),
          consumers: numberOrUndefined(object.consumers),
        };
      },
      deleteQueue: async (queue) => {
        await call({ method: 'DELETE', path: `${queues}/${encode(queue)}`, ok: [204] });
      },
      getMessages: async (queue, count) => {
        const reply = await call({
          method: 'POST',
          path: `${queues}/${encode(queue)}/get`,
          body: { count, ackmode: 'ack_requeue_false', encoding: 'auto' },
          ok: [200],
        });
        return reply.body as QueueMessage[];
      },
      alarms: async () =>
        (await call({ method: 'GET', path: '/health/checks/alarms', ok: [200, 503] })).status,
    };
  };

  return {
    createVhost: async (name) => {
      await call({
        method: 'PUT',
        path: `/vhosts/${encode(name)}`,
        body: { description: 'integration test' },
        ok: [201, 204],
      });
    },
    deleteVhost: async (name) => {
      await call({ method: 'DELETE', path: `/vhosts/${encode(name)}`, ok: [204] });
    },
    hasVhost: async (name) =>
      (await call({ method: 'GET', path: `/vhosts/${encode(name)}`, ok: [200, 404] })).status ===
      200,
    grantAll: async (name, grantee) => {
      await call({
        method: 'PUT',
        path: `/permissions/${encode(name)}/${encode(grantee)}`,
        body: { configure: '.*', write: '.*', read: '.*' },
        ok: [201, 204],
      });
    },
    vhost,
  };
}
