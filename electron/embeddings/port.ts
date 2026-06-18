import * as net from "net";

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("No port obtained"));
      });
    });
    server.on("error", (err) => reject(err));
  });
}
