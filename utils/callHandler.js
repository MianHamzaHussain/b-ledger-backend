/**
 * Run an Express handler from server code (not from a request) and get what it would have sent back. Used where
 * one part of the app must do what an existing endpoint does — create or edit an order — without copying its rules
 * (stock holding, customer matching, alerts). A refusal (`next(err)`) becomes a rejected promise.
 */
export const callHandler = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
        return this;
      }
    };
    Promise.resolve(handler(req, res, err => reject(err))).catch(reject);
  });
