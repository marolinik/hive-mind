/**
 * Prompt-injection scanner — pattern-based detection for role-override,
 * prompt-extraction, and instruction-injection attempts.
 *
 * Lives at the top of `@hive-mind/core` so the harvest pipeline — which
 * ingests untrusted external conversation exports — can call it without
 * a cross-package dependency.
 *
 * Three pattern sets:
 * - ROLE_OVERRIDE: "ignore previous instructions", "you are now…", memory-wipe attempts
 * - PROMPT_EXTRACTION: "print your system prompt", "reveal your instructions"
 * - INSTRUCTION_INJECTION: fake "IMPORTANT:", "SYSTEM:", "[INST]" authority markers
 */

export interface ScanResult {
  safe: boolean;
  score: number;
  flags: string[];
}

const ROLE_OVERRIDE_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions?\s*:/i,
  /forget\s+(everything|all|your)\s+(you|instructions|rules)/i,
  /override\s+(your|the|all)\s+(instructions|rules|prompt)/i,
  /disregard\s+(your|the|all|previous)\s+(instructions|rules|prompt)/i,
  /ignoriere\s+alle/i,
  /ignora\s+todas/i,
  /ignorez\s+toutes/i,
  // Memory wipe — "forget everything", "erase all context", etc.
  /(?:forget|erase|clear|wipe|reset)\s+(?:everything|conversation|memory|context|history|all)/i,
  // Role override — "from now on you are", "pretend you are", "your new role is"
  /(?:from\s+now\s+on\s+you\s+are|act\s+as\s+if\s+you\s+are|pretend\s+you\s+are|your\s+new\s+role\s+is)/i,
];

const PROMPT_EXTRACTION_PATTERNS = [
  /print\s+(your|the)\s+system\s+prompt/i,
  /show\s+(me\s+)?(your|the)\s+(system\s+)?prompt/i,
  /what\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions|rules)/i,
  /repeat\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /output\s+(your|the)\s+(system\s+)?prompt\s+verbatim/i,
  // Instruction disclosure — "reveal your instructions", "disclose your prompt", etc.
  /(?:reveal|disclose|show|display|print|output|dump)\s+(?:your\s+)?(?:instructions|system\s+prompt|rules|guidelines|configuration|training)/i,
];

const INSTRUCTION_INJECTION_PATTERNS = [
  /IMPORTANT\s*:\s*(ignore|disregard|forget|override)/i,
  /SYSTEM\s*:\s*/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /\bASSISTANT\s*:\s*/i,
  /BEGIN\s+NEW\s+INSTRUCTIONS/i,
  // Authority claims — fake system/admin messages
  /(?:system\s+message|admin\s+message|admin\s+override|elevated\s+privileges|root\s+access|operator\s+mode|maintenance\s+mode|debug\s+mode)/i,
];

export function scanForInjection(
  text: string,
  context: 'user_input' | 'tool_output' = 'user_input'
): ScanResult {
  const flags: string[] = [];
  let score = 0;

  for (const pattern of ROLE_OVERRIDE_PATTERNS) {
    if (pattern.test(text)) { flags.push('role_override'); score += 0.5; break; }
  }

  for (const pattern of PROMPT_EXTRACTION_PATTERNS) {
    if (pattern.test(text)) { flags.push('prompt_extraction'); score += 0.4; break; }
  }

  for (const pattern of INSTRUCTION_INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      flags.push('instruction_injection');
      score += context === 'tool_output' ? 0.6 : 0.3;
      break;
    }
  }

  score = Math.min(score, 1.0);

  return { safe: score < 0.3, score, flags };
}
