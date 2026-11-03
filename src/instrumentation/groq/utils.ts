import { Span } from "@opentelemetry/api";
import { NetraLogger } from "../../netraLogger";
import {
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";

export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string
): void {
  if (!span.isRecording()) {
    NetraLogger.log("Span is not recording");
    return;
  }
  setBaseRequestAttributes(span, kwargs, requestType, "groq");
}

export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  if (!span.isRecording()) {
    NetraLogger.log("Span is not recording");
    return;
  }
  setBaseResponseAttributes(span, response);
}
