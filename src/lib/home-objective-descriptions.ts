import "server-only";

import { OBJECTIVE_DEFINITIONS } from "@/lib/objectives";

export const HOME_OBJECTIVE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(OBJECTIVE_DEFINITIONS.map(({ id, description }) => [id, description])),
);
