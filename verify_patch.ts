import { GoogleGenAI } from "@google/genai";
import { googleGenAIInstrumentor } from "./src/instrumentation/google-genai/index.ts";

const client = new GoogleGenAI({
  apiKey: "AIzaSyALq4VgvfhF6dLVC-RDH5jKH3Pl2AjwY98",
});
console.log(JSON.stringify(GoogleGenAI.prototype.models));
