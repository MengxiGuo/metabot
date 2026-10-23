import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileCatchupSkillsToWorkDirs } from '../src/api/skills-installer.js';

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-catchup-install-'));
  temporaryRoots.push(root);
  return root;
}

function createCanonicalSource(root: string): string {
  const source = path.join(root, 'canonical-catchup');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# canonical catchup\n');
  fs.writeFileSync(path.join(source, 'scripts', 'catchup_context.py'), 'print("catchup")\n');
  fs.writeFileSync(path.join(source, 'agents', 'openai.yaml'), 'interface:\n  display_name: Catchup\n');
  return source;
}

function expectedTargets(homeDir: string, workDir: string): string[] {
  return [
    path.join(homeDir, '.agents', 'skills', 'catchup'),
    path.join(homeDir, '.codex', 'skills', 'catchup'),
    path.join(homeDir, '.claude', 'skills', 'catchup'),
    path.join(workDir, '.agents', 'skills', 'catchup'),
    path.join(workDir, '.claude', 'skills', 'catchup'),
  ];
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('reconcileCatchupSkillsToWorkDirs', () => {
  it('installs idempotent regular-file copies into global and workdir discovery paths', () => {
    const root = makeTemporaryRoot();
    const sourceRoot = createCanonicalSource(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workdir');
    fs.mkdirSync(homeDir);
    fs.mkdirSync(workDir);
    const logger = { info: vi.fn() } as any;
    const options = {
      installerPath: path.resolve('bin/install-catchup-skill'),
      sourceRoot,
      homeDir,
    };

    reconcileCatchupSkillsToWorkDirs([workDir, workDir], logger, options);
    reconcileCatchupSkillsToWorkDirs([workDir], logger, options);

    for (const target of expectedTargets(homeDir, workDir)) {
      for (const relativeFile of ['SKILL.md', 'scripts/catchup_context.py', 'agents/openai.yaml']) {
        const installed = path.join(target, relativeFile);
        expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(installed)).toEqual(fs.readFileSync(path.join(sourceRoot, relativeFile)));
      }
    }
    expect(logger.info).toHaveBeenLastCalledWith(
      { workDirCount: 1 },
      'Canonical catchup skill reconciled',
    );
  });

  it('rejects unsafe relative workdirs before writing to them', () => {
    const root = makeTemporaryRoot();
    const sourceRoot = createCanonicalSource(root);
    const homeDir = path.join(root, 'home');
    fs.mkdirSync(homeDir);

    expect(() => reconcileCatchupSkillsToWorkDirs(
      ['relative-workdir'],
      { info: vi.fn() } as any,
      {
        installerPath: path.resolve('bin/install-catchup-skill'),
        sourceRoot,
        homeDir,
      },
    )).toThrow();
  });
});
