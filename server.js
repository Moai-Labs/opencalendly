// Entry point. Node's standard library only.
"use strict";

const { createApp } = require("./lib/app");

const port = Number(process.env.PORT) || 3000;
const app = createApp();

app.server.listen(port, () => {
  console.log(`listening on ${port}, data dir ${app.dataDir}, mail ${app.mailer.configured ? "configured" : "not configured (emails queue in the dashboard)"}`);
});
