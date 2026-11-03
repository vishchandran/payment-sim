process.env.ADMIN_API_KEYS = "observability-admin-key";

const { app } = require("../app");
const pool = require("../db/connection");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    assert(live.status === 200, "expected liveness check to succeed");

    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert(ready.status === 200, "expected readiness check to verify dependencies");

    const unauthorizedMetrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert(unauthorizedMetrics.status === 401, "expected metrics to require admin auth");

    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { "x-admin-api-key": "observability-admin-key" },
    });
    const body = await metrics.text();
    assert(metrics.status === 200, "expected authorized metrics request to succeed");
    assert(body.includes("payment_sim_http_requests_total"), "expected HTTP metrics");
    assert(body.includes("payment_sim_outbox_events"), "expected outbox metrics");
    assert(body.includes("payment_sim_outbox_oldest_event_age_seconds"), "expected outbox age metrics");
    assert(body.includes("payment_sim_expired_processing_leases"), "expected processing lease metrics");
    assert(body.includes("payment_sim_dead_letter_jobs"), "expected dead-letter metrics");

    console.log("PASS liveness, readiness, and protected operational metrics");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error("FAIL", error.stack || error.message || error);
  await pool.end().catch(() => {});
  process.exit(1);
});
