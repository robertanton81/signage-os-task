// Entry point of the processing service. The RabbitMQ consumer, deduplication
// and the device-state update in MongoDB are wired here in TODO step 5; step 1
// only establishes the package so the workspace, build and lint setup is
// exercised.
export const SERVICE_NAME = 'processing';
