// The race's command stories. Every command is verbatim from the bootcamp
// slides (inventory: ~/repo/slides-devops-bootcamp/slides/2026, up to CI/CD 3),
// and each story is SEQUENCED — run top to bottom it is one coherent workflow,
// every line's precondition set up by the line before. The order IS the
// lesson, so prompts are never shuffled.
export const STORIES = {
  // CI/CD 3 race — "fork to first contact": sign in, fork the ship, pass the
  // gate, build, push, wire the secret, launch the pipeline, find your URL.
  cicd3: [
    'gh auth login',
    'gh repo fork Infratify/devops-bootcamp-shipit --clone',
    'cd devops-bootcamp-shipit',
    'code .',
    'git status',
    'cd launchpad && npm run test',
    'npm run build',
    'git add .',
    'git commit -m "kemas laman"',
    'git push',
    'gh secret set SHIPIT_TOKEN',
    'gh secret list',
    'gh workflow run deploy.yaml',
    'gh workflow view -w',
    'echo $?',
    'gh api repos/{owner}/{repo}/pages --jq .html_url',
  ],
  // CI/CD 4 race — "capstone: container to your own server": sync the fork,
  // pass the gate, containerise, verify, ship it to EC2, merge the ritual PR.
  cicd4: [
    'git fetch upstream',
    'git merge upstream/main',
    'cd launchpad && npm run test',
    'npm run build',
    'docker build -t web:v1 .',
    'docker images',
    'docker run -d -p 8080:80 --name web web:v1',
    'docker ps',
    'docker logs -f web',
    'docker tag web:v1 infratify/web:v1',
    'aws sts get-caller-identity',
    'ssh bootcamp',
    'curl -fsSL https://get.docker.com | sudo sh',
    'docker compose pull',
    'docker compose up -d',
    'docker compose ps',
    'curl -s https://checkip.amazonaws.com',
    'exit',
    'gh pr create --fill',
    'gh pr merge --squash --delete-branch',
  ],
};

// Known race sessions (app.js validates /api/race/start against these keys).
export const SESSIONS = STORIES;

export function pickPrompts(session) {
  return [...(STORIES[session] || [])];
}
