import http from "k6/http";
import { check } from "k6";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

// Load test the running HTTP server. Seed a HIGH-stock SKU first so you measure
// reservation throughput rather than a wall of 409s:
//   npm run seed   (or reserve against a SKU with large stock)
//   npm start
//   k6 run loadtest/k6-reserve.js
const BASE = __ENV.BASE_URL || "http://localhost:3000";
const SKU = __ENV.SKU || "MILK-1L";
const STRATEGY = __ENV.STRATEGY || "atomic";

export const options = {
  scenarios: {
    reserve_burst: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 50 },
        { duration: "20s", target: 200 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    // a reservation either succeeds (201) or is a legitimate stock-out (409)
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export default function () {
  const res = http.post(
    `${BASE}/reserve`,
    JSON.stringify({ sku: SKU, qty: 1, strategy: STRATEGY }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uuidv4(),
      },
    },
  );
  check(res, {
    "reserved or sold-out": (r) => r.status === 201 || r.status === 409,
  });
}
