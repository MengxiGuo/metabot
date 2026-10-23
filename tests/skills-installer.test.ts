import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSkillFromHub, installSkillsToWorkDir } from '../src/api/skills-installer.js';

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-skill-install-'));
  temporaryRoots.push(root);
  return root;
}

function writeSkill(root: string, name: string, body: string): void {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('workspace skill installation', () => {
  it('copies bundled and global skills to Claude and Antigravity discovery trees', () => {
    const root = makeTemporaryRoot();
    const workDir = path.join(root, 'work');
    const homeDir = path.join(root, 'home');
    const bundledSkillsDir = path.join(root, 'bundled');
    fs.mkdirSync(workDir, { recursive: true });
    writeSkill(bundledSkillsDir, 'metabot', '# bundled metabot\n');
    writeSkill(path.join(homeDir, '.agents', 'skills'), 'lark-base', '# global lark base\n');

    installSkillsToWorkDir(workDir, { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as any, {
      platform: 'feishu',
      homeDir,
      bundledSkillsDir,
    });

    for (const discoveryRoot of ['.claude/skills', '.agents/skills']) {
      expect(fs.readFileSync(path.join(workDir, discoveryRoot, 'metabot', 'SKILL.md'), 'utf8')).toBe(
        '# bundled metabot\n',
      );
      expect(fs.readFileSync(path.join(workDir, discoveryRoot, 'lark-base', 'SKILL.md'), 'utf8')).toBe(
        '# global lark base\n',
      );
    }
  });

  it('mirrors Skill Hub installs into the Antigravity discovery tree', () => {
    const root = makeTemporaryRoot();
    const workDir = path.join(root, 'work');
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    installSkillFromHub(workDir, 'review-helper', '# review helper\n', undefined, logger);

    expect(fs.readFileSync(path.join(workDir, '.claude/skills/review-helper/SKILL.md'), 'utf8')).toBe(
      '# review helper\n',
    );
    expect(fs.readFileSync(path.join(workDir, '.agents/skills/review-helper/SKILL.md'), 'utf8')).toBe(
      '# review helper\n',
    );
  });
});
