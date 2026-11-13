// Runs once in the main process before any worker starts. The timezone is
// process-wide: a worker thread can't change it by assigning process.env.TZ.
// Date tests compare server-rendered UTC labels with local ones, so they need
// a zone that differs from UTC, whatever the machine or CI runner uses.
export default function setup() {
  process.env.TZ = "America/New_York"
}
