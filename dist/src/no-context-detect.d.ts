/**
 * Detect when an agent reply explicitly declares it lacks prior context.
 *
 * Used by the output hook for auto-switch-back: when a message was mis-routed to a
 * freshly auto-created (empty) topic, the agent answers "this is a new session, I
 * have no prior context". Detecting that lets us switch the active topic back to the
 * parent so the user's next message lands in the right place — instead of forcing
 * them to type `/switch <label>` manually.
 *
 * The matcher MUST be narrow: it fires ONLY on an explicit "I have no context"
 * declaration, never on a generic clarifying question. A legitimate new topic also
 * asks clarifying questions; treating those as mis-routes would merge real new topics
 * back into the old one — exactly the topic-collapse failure the runaway valve fixed.
 */
import type { OpenClawEvent } from './types.js';
/** True if the text explicitly declares a lack of prior context. */
export declare function looksLikeNoContext(text: string): boolean;
/**
 * Pull the assistant's reply text out of the various output-hook event shapes
 * (llm_output / agent_end / reply). Returns '' if none found.
 */
export declare function extractAssistantText(event: OpenClawEvent): string;
