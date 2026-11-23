/** In-process CLI test provider: records incoming user messages and never contacts a service. */
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";

export default function localProvider(pi: any) {
	pi.registerProvider("sandbox-smoke", {
		api: "sandbox-smoke-api",
		baseUrl: "http://unused.invalid",
		apiKey: "local-test-only",
		models: [{ id: "smoke", name: "Local smoke provider", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model: any, context: any) {
			const path = process.env.PI_SANDBOX_SMOKE_CONTEXT_PATH;
			if (!path) throw new Error("missing isolated smoke context path");
			appendFileSync(path, JSON.stringify(context.messages.filter((message: any) => message.role === "user")) + "\n");
			const message = { ...fauxAssistantMessage("LOCAL_SMOKE_ACK"), api: model.api, provider: model.provider, model: model.id };
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
}
