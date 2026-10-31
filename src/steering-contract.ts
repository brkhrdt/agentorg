/** Private ACP extension for adding guidance to an existing prompt operation. */
export const STEERING_EXTENSION = "agentorg.inPlaceSteering";
export const STEERING_METHOD = "_agentorg/session/steer";
export const STEERING_VERSION = 2;

export interface SteeringCapability {
  version: typeof STEERING_VERSION;
}

export interface SteeringRunMetadata {
  version: typeof STEERING_VERSION;
  operationId: string;
}

export interface SteeringRequest {
  sessionId: string;
  operationId: string;
  steeringId: string;
  text: string;
}

/** A harness accepts the guidance for asynchronous delivery after validating the exact run. */
export interface SteeringResponse {
  operationId: string;
  steeringId: string;
  disposition: "pending";
}

/** Terminal delivery updates are reported asynchronously by the harness adapter. */
export interface SteeringStatus {
  sessionId: string;
  operationId: string;
  steeringId: string;
  status: "delivered" | "failed";
  error?: { code?: string; message: string };
}

export const STEERING_STATUS_METHOD = "_agentorg/session/steer_status";

export function steeringCapability(value: unknown): value is SteeringCapability {
  return value !== null && typeof value === "object" &&
    (value as Record<string, unknown>).version === STEERING_VERSION;
}
