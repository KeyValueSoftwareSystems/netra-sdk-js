import { Span } from "@opentelemetry/api";
import { Logger } from "../../logger";
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
    Logger.log("Span is not recording");
    return;
  }
  setBaseRequestAttributes(span, kwargs, requestType, "anthropic");
}

export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  if (!span.isRecording()) {
    Logger.log("Span is not recording");
    return;
  }
  if(response?.type === 'message_batch'){
    span.setAttribute("status", response?.processing_status as string);
  }
  setBaseResponseAttributes(span, response);
}
