/** Where the bridge may fetch a candidate ref that a target reported. */
export interface CandidateRefLocation {
  /** A plain ref name or commit SHA, never a refspec, revision expression or pattern. */
  ref: string;
  /** The GitHub `owner/repo` that holds `ref` when it is not the handoff's repository. */
  repository?: string;
}

// GitHub account and repository names.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPOSITORY = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/**
 * Accepts what `git check-ref-format --allow-onelevel` accepts, except a leading `-` or `+`
 * (option and forced-refspec syntax), so the ref can never widen into a refspec.
 */
export function isPlainGitRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 256 && ref !== "@" &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(ref) &&
    !/^[-+/]|\/$|\/\/|\.\.|@\{|\.$|\.lock(?:\/|$)|(?:^|\/)\./.test(ref);
}

/**
 * Resolves a reported candidate ref. A target may qualify it with its GitHub repository, as in
 * `owner/repo:refs/heads/branch`. Anything else must be a plain ref.
 */
export function parseCandidateRef(candidateRef: string, repoId: string): CandidateRefLocation | undefined {
  const qualified = /^([^/:]+)\/([^/:]+):(.*)$/.exec(candidateRef);
  if (!qualified) return isPlainGitRef(candidateRef) ? { ref: candidateRef } : undefined;
  const [, owner = "", name = "", ref = ""] = qualified;
  if (!OWNER.test(owner) || !REPOSITORY.test(name) || !isPlainGitRef(ref)) return undefined;
  const repository = `${owner}/${name}`;
  // GitHub names are case-insensitive.
  return repository.toLowerCase() === repoId.trim().toLowerCase() ? { ref } : { ref, repository };
}

export function githubCloneUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}
