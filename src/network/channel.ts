/**
 * A channel: a duplex stream of text frames between a party and the core, over one WebSocket.
 * Both ends use it, the core around the socket it accepted and a party around the one it dialed.
 * The socket's owner feeds it frames with `receive` and the socket's end with `closed`; its user
 * takes them with `listen`, and frames that arrive before that wait for it. Others may watch for
 * its end with `whenClosed`.
 */

export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export class Channel {
  /** The WebSocket close code, once the channel has closed. */
  closeCode: number | undefined;
  private readonly socket: Socket;
  private early: string[] | undefined = [];
  private onmessage: ((text: string) => void) | undefined;
  private onclose: ((code: number | undefined) => void) | undefined;
  private readonly watchers: ((code: number | undefined) => void)[] = [];
  private ended = false;

  constructor(socket: Socket) {
    this.socket = socket;
  }

  /** Take this channel's frames and its end. */
  listen(onmessage: (text: string) => void, onclose: (code: number | undefined) => void): void {
    this.onmessage = onmessage;
    this.onclose = onclose;
    const early = this.early ?? [];
    this.early = undefined;
    for (const text of early) onmessage(text);
    if (this.ended) onclose(this.closeCode);
  }

  /** Call `watcher` once the channel has closed, at once if it already has. */
  whenClosed(watcher: (code: number | undefined) => void): void {
    if (this.ended) watcher(this.closeCode);
    else this.watchers.push(watcher);
  }

  send(text: string): void {
    if (this.ended) throw new Error("the channel is closed");
    this.socket.send(text);
  }

  close(code?: number, reason?: string): void {
    if (!this.ended) this.socket.close(code, reason);
    this.closed(code);
  }

  receive(text: string): void {
    if (this.early) this.early.push(text);
    else this.onmessage?.(text);
  }

  closed(code?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.closeCode = code;
    this.onclose?.(code);
    for (const watcher of this.watchers) watcher(code);
  }
}

/** Dial a channel to a `ws:` or `wss:` address. Admission follows on the opened channel. */
export async function dial(url: URL): Promise<Channel> {
  const socket = new WebSocket(url);
  const channel = new Channel({
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  });
  socket.onmessage = (event) => channel.receive(String(event.data));
  await new Promise<void>((resolve, reject) => {
    const refused = (message: string) => {
      socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null;
      channel.close();
      reject(new Error(message));
    };
    socket.onopen = () => {
      socket.onopen = socket.onerror = null;
      socket.onclose = (event) => channel.closed(event.code);
      resolve();
    };
    socket.onerror = () => refused("the core channel failed to open");
    socket.onclose = (event) => refused(`the core refused the channel (${event.code})`);
  });
  return channel;
}
