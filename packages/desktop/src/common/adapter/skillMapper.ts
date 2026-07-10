export interface RawAvailableSkill {
  name: string;
  description: string;
  location: string;
  relative_location?: string;
  is_custom: boolean;
  source: 'builtin' | 'custom' | 'extension';
}

export interface BuiltinAutoSkill {
  name: string;
  description: string;
  location: string;
}

/**
 * Derive the auto-injected catalog from the canonical `/api/skills` response.
 * AionCore 0.1.37 removed `GET /api/skills/builtin-auto`, while older builds
 * exposed the same entries through both routes. Keeping the compatibility
 * mapping in the bridge prevents one missing legacy route from blanking the
 * complete skill picker.
 */
export function fromAvailableSkillsToBuiltinAutoSkills(skills: RawAvailableSkill[]): BuiltinAutoSkill[] {
  return skills
    .filter(
      (skill) =>
        skill.source === 'builtin' &&
        typeof skill.relative_location === 'string' &&
        skill.relative_location.startsWith('auto-inject/')
    )
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      location: skill.relative_location!,
    }));
}
