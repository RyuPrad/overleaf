// http-body.js
// Bounded JSON body reader for the local API.

/**
 * Read and parse a JSON request body with a hard size limit.
 * Oversized bodies reject with err.status = 413 without destroying the
 * socket immediately, so the HTTP handler can still send a JSON 413.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<object>}
 */
export function readRequestJson(req, maxBytes) {
  const limit = Math.max(1024, Number(maxBytes) || 2 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        req.pause();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        const err = new Error(`Request body too large (max ${limit} bytes)`);
        err.status = 413;
        fail(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const data = Buffer.concat(chunks).toString("utf8");
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => fail(err));
  });
}
