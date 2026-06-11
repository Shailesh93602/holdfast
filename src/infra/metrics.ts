import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const reservationsTotal = new client.Counter({
  name: "qc_reservations_total",
  help: "Reservation attempts by strategy and result",
  labelNames: ["strategy", "result"] as const,
  registers: [registry],
});

export const reservationDuration = new client.Histogram({
  name: "qc_reservation_duration_seconds",
  help: "End-to-end reservation latency by strategy",
  labelNames: ["strategy"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const optimisticCasAttempts = new client.Histogram({
  name: "qc_optimistic_cas_attempts",
  help: "Compare-and-swap attempts per successful optimistic reservation",
  buckets: [1, 2, 3, 5, 8, 13, 21],
  registers: [registry],
});
