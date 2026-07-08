// pm2 process manager for the keeper + gasless relayer (run on an always-on VPS).
//   pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup
// Keeps it alive across crashes/reboots. Logs: pm2 logs xkub-keeper
module.exports = {
  apps: [
    {
      name: "xkub-keeper",
      cwd: __dirname + "/..",
      script: "npm",
      args: "run keeper:perp:testnet",
      env: {
        RELAYER_PORT: "8799",
        // KUB_PRIVATE_KEY is read from .env — keep it there, never commit it.
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      time: true,
    },
  ],
};
