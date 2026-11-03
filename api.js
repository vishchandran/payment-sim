const { app } = require("./app");
const { config, validateRuntimeConfiguration } = require("./config/config");
const pool = require("./db/connection");
const { closeRateLimiter } = require("./infrastructure/http/rateLimiter");
const {
  validateAdminApiKeyConfiguration,
  validateApiKeyConfiguration,
} = require("./infrastructure/http/apiKeyAuth");

validateApiKeyConfiguration();
validateAdminApiKeyConfiguration();
validateRuntimeConfiguration();

console.log("PORT FROM ENV:", process.env.PORT);
console.log("CONFIG PORT:", config.port);

const server = app.listen(config.port, () => {
  console.log(`API server running on http://localhost:${config.port}`);
});

async function shutdown(signal) {
  console.log(`API_SHUTDOWN_STARTED: signal=${signal}`);

  server.close(async (error) => {
    if (error) {
      console.error("API_SERVER_CLOSE_ERROR:", error.message);
      process.exit(1);
    }

    try {
      await closeRateLimiter();
      await pool.end();
      console.log("API_SHUTDOWN_COMPLETE");
      process.exit(0);
    } catch (closeError) {
      console.error("API_DB_CLOSE_ERROR:", closeError.message);
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
