import { GitHub } from '@/server/modules/GitHub';
import { SkillParser } from '@/server/services/skill';

export interface GitHubSkillSource {
  content?: string;
  manifest?: Record<string, unknown>;
  resources?: Record<string, { size: number }>;
}

const github = new GitHub({ userAgent: 'LobeHub-Nexus-Registry' });
const parser = new SkillParser();

export const loadGitHubSkillSource = async (
  repositoryUrl: string,
): Promise<GitHubSkillSource | undefined> => {
  const repoInfo = github.parseRepoUrl(repositoryUrl);
  const zipBuffer = await github.downloadRepoZip(repoInfo);
  const { content, manifest, resources } = await parser.parseZipPackage(zipBuffer, {
    basePath: repoInfo.path,
  });
  const resourceMetadata = Object.fromEntries(
    [...resources.entries()].map(([path, buffer]) => [path, { size: buffer.byteLength }]),
  );

  return {
    content: content.trim(),
    manifest,
    resources: resourceMetadata,
  };
};
