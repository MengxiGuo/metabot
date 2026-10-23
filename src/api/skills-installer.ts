import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import type { Logger } from '../utils/logger.js';

/** Skills installed for all platforms. */
const COMMON_SKILLS = ['metaskill', 'metamemory', 'metabot', 'phone-call', 'voice', 'skill-hub', 'catchup'];

/** Lark CLI AI Agent skills — installed via `npx skills add larksuite/cli` and
 *  normally installed into a global discovery tree. We copy them to both
 *  workspace discovery trees so Claude-compatible engines and Antigravity can
 *  use the same skills. */
const LARK_CLI_SKILLS = [
  'lark-base',
  'lark-calendar',
  'lark-contact',
  'lark-doc',
  'lark-drive',
  'lark-event',
  'lark-im',
  'lark-mail',
  'lark-minutes',
  'lark-openapi-explorer',
  'lark-shared',
  'lark-sheets',
  'lark-skill-maker',
  'lark-task',
  'lark-vc',
  'lark-whiteboard',
  'lark-wiki',
  'lark-workflow-meeting-summary',
  'lark-workflow-standup-report',
];

export interface InstallSkillsOptions {
  /** Bot platform — feishu-only skills are skipped for other platforms. */
  platform?: 'feishu' | 'telegram' | 'web' | 'wechat';
  /** Feishu app credentials for lark-cli auto-config (feishu only). */
  feishuAppId?: string;
  feishuAppSecret?: string;
  /** Test/deployment override for the user's home directory. */
  homeDir?: string;
  /** Test/deployment override for MetaBot's bundled skills directory. */
  bundledSkillsDir?: string;
}

export interface ReconcileCatchupSkillsOptions {
  installerPath?: string;
  sourceRoot?: string;
  homeDir?: string;
}

function resolveCatchupInstaller(explicitPath?: string): string {
  const thisFile = url.fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  const candidates = [
    explicitPath,
    process.env.METABOT_CATCHUP_INSTALLER,
    path.join(process.env.METABOT_HOME || path.join(os.homedir(), 'metabot'), 'bin', 'install-catchup-skill'),
    path.join(thisDir, '..', '..', 'bin', 'install-catchup-skill'),
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Canonical catchup installer was not found');
}

/**
 * Install the canonical catchup skill as real files in every engine discovery
 * tree. The shell entrypoint owns parity validation and safe replacement of
 * legacy file-level symlinks.
 */
export function reconcileCatchupSkillsToWorkDirs(
  workDirs: string[],
  logger: Logger,
  options: ReconcileCatchupSkillsOptions = {},
): void {
  const installerPath = resolveCatchupInstaller(options.installerPath);
  for (const workDir of workDirs) {
    if (!path.isAbsolute(workDir) || path.parse(workDir).root === path.resolve(workDir)) {
      throw new Error(`Unsafe catchup workdir: ${workDir}`);
    }
  }
  const uniqueWorkDirs = Array.from(new Set(workDirs.map((workDir) => path.resolve(workDir))));
  const env = {
    ...process.env,
    ...(options.sourceRoot ? { METABOT_CATCHUP_SOURCE: options.sourceRoot } : {}),
    ...(options.homeDir ? { HOME: options.homeDir } : {}),
  };

  execFileSync(installerPath, uniqueWorkDirs, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  logger.info({ workDirCount: uniqueWorkDirs.length }, 'Canonical catchup skill reconciled');
}

function bundledSkillsDirs(explicitDir?: string): string[] {
  const thisFile = url.fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  return [explicitDir, path.join(thisDir, '..', 'skills'), path.join(thisDir, '..', '..', 'src', 'skills')].filter(
    (candidate): candidate is string => !!candidate,
  );
}

function workspaceSkillDestinations(workDir: string, skill: string): string[] {
  return [path.join(workDir, '.claude', 'skills', skill), path.join(workDir, '.agents', 'skills', skill)];
}

function resolveSkillSource(skill: string, options?: InstallSkillsOptions): string | undefined {
  const homeDir = options?.homeDir ?? os.homedir();
  const candidates = [
    ...bundledSkillsDirs(options?.bundledSkillsDir).map((root) => path.join(root, skill)),
    path.join(homeDir, '.agents', 'skills', skill),
    path.join(homeDir, '.claude', 'skills', skill),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')));
}

export function installSkillsToWorkDir(workDir: string, logger: Logger, options?: InstallSkillsOptions): void {
  const skillNames = options?.platform === 'feishu' ? [...COMMON_SKILLS, ...LARK_CLI_SKILLS] : COMMON_SKILLS;

  for (const skill of skillNames) {
    const src = resolveSkillSource(skill, options);

    if (!src) {
      logger.debug({ skill }, 'Skill source not found, skipping');
      continue;
    }

    const destinations = workspaceSkillDestinations(workDir, skill);
    for (const dest of destinations) {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    }
    logger.info({ skill, src, destinations }, 'Skill installed to working-directory discovery trees');
  }

  // For Feishu bots, ensure lark-cli is configured
  if (options?.platform === 'feishu' && options.feishuAppId && options.feishuAppSecret) {
    ensureLarkCliConfig(options.feishuAppId, options.feishuAppSecret, logger);
  }

  // Deploy workspace CLAUDE.md if not already present
  const destClaudeMd = path.join(workDir, 'CLAUDE.md');
  if (!fs.existsSync(destClaudeMd)) {
    const thisFile = url.fileURLToPath(import.meta.url);
    const thisDir = path.dirname(thisFile);
    // Try src/workspace/CLAUDE.md (tsx) or dist/workspace/CLAUDE.md (compiled)
    for (const candidate of [
      path.join(thisDir, '..', 'workspace', 'CLAUDE.md'),
      path.join(thisDir, '..', '..', 'src', 'workspace', 'CLAUDE.md'),
    ]) {
      if (fs.existsSync(candidate)) {
        fs.copyFileSync(candidate, destClaudeMd);
        logger.info({ dest: destClaudeMd }, 'CLAUDE.md deployed to working directory');
        break;
      }
    }
  }
}

/**
 * Ensure lark-cli is configured with Feishu app credentials.
 * Skips if ~/.lark-cli/config.json already exists.
 */
function ensureLarkCliConfig(appId: string, appSecret: string, logger: Logger): void {
  const configPath = path.join(os.homedir(), '.lark-cli', 'config.json');
  if (fs.existsSync(configPath)) {
    logger.debug('lark-cli already configured, skipping');
    return;
  }

  // Find lark-cli binary
  const larkCliBin = findLarkCli();
  if (!larkCliBin) {
    logger.warn(
      'lark-cli not found in PATH or ~/.npm-global/bin — skipping config. Run: npm install -g @larksuite/cli',
    );
    return;
  }

  try {
    execFileSync(larkCliBin, ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'], {
      input: appSecret,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    logger.info({ appId }, 'lark-cli configured successfully');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to configure lark-cli — you can run manually: lark-cli config init');
  }
}

/**
 * Install a skill from the Skill Hub into a bot's working directory.
 * Writes SKILL.md and optionally extracts references/ from a tar buffer.
 */
export function installSkillFromHub(
  workDir: string,
  skillName: string,
  skillMd: string,
  referencesTar: Buffer | undefined,
  logger: Logger,
): void {
  const [destDir, ...mirrorDirs] = workspaceSkillDestinations(workDir, skillName);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'SKILL.md'), skillMd, 'utf-8');

  if (referencesTar && referencesTar.length > 0) {
    try {
      execSync(`tar xf - -C "${destDir}"`, { input: referencesTar, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
    } catch (err: any) {
      logger.warn({ err: err.message, skillName }, 'Failed to extract references tar');
    }
  }

  for (const mirrorDir of mirrorDirs) {
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.cpSync(destDir, mirrorDir, { recursive: true });
  }

  logger.info(
    { skillName, destinations: [destDir, ...mirrorDirs] },
    'Skill installed from Hub into workspace discovery trees',
  );
}

/** Locate the lark-cli executable. */
function findLarkCli(): string | null {
  const candidates = [path.join(os.homedir(), '.npm-global', 'bin', 'lark-cli'), '/usr/local/bin/lark-cli'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Try PATH via which
  try {
    const result = execFileSync('which', ['lark-cli'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5_000 });
    const p = result.toString().trim();
    if (p) return p;
  } catch {
    /* not in PATH */
  }
  return null;
}
