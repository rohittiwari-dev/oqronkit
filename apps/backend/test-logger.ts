import { createLogger } from "chronoforge";

const logger = createLogger({
  enabled: true,
  level: "debug",
  prettify: true,
  redact: ["password"],
});

logger.warn("Test logger with string filter");
logger.warn("Test logger with object filter", {
  user: { password: "123", email: "a@b.com" },
});
