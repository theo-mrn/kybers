/**
 * Modèles de pipeline pour déclencher un déploiement Kybers.
 *
 * Kybers ne construit pas les images : ces workflows tournent chez le client,
 * construisent, poussent vers son registry, puis appellent l'API. Le chemin
 * reste valable quel que soit son outil de CI — c'est pourquoi on fournit un
 * texte à copier plutôt qu'une intégration qui imposerait GitHub.
 */

export type Provider = "github" | "gitlab" | "curl";

export const PROVIDERS: { key: Provider; label: string; file: string }[] = [
  { key: "github", label: "GitHub Actions", file: ".github/workflows/deploy.yml" },
  { key: "gitlab", label: "GitLab CI", file: ".gitlab-ci.yml" },
  { key: "curl", label: "Autre CI", file: "" },
];

export type TemplateInput = {
  /** URL publique du Control Plane, appelée par la pipeline. */
  baseUrl: string;
  appId: string;
  appName: string;
  environment: string;
  /** Registry cible ; sert d'exemple, le client y pousse ses images. */
  registry: string;
};

/** Nom du secret attendu dans le CI ; référencé par toutes les étapes. */
export const TOKEN_SECRET = "KYBERS_TOKEN";

export function workflow(provider: Provider, input: TemplateInput): string {
  const { baseUrl, appId, appName, environment, registry } = input;
  const endpoint = `${baseUrl}/api/v1/apps/${appId}/deploy`;

  if (provider === "github") {
    return `name: Déployer sur Kybers

on:
  push:
    branches: [main]

env:
  IMAGE: ${registry}/\${{ github.repository }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      # Construction et publication de l'image : cette partie vous appartient,
      # Kybers ne fait que déployer ce que vous avez publié.
      - uses: docker/login-action@v3
        with:
          registry: ${registry}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: \${{ env.IMAGE }}:\${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      # Déclenchement du déploiement. Les champs git_* sont facultatifs : ils
      # permettent de retrouver quel commit tourne en production.
      - name: Déployer ${appName} sur ${environment}
        run: |
          curl -sSf -X POST ${endpoint} \\
            -H "Authorization: Bearer \${{ secrets.${TOKEN_SECRET} }}" \\
            -H "Content-Type: application/json" \\
            -d '{
              "environment": "${environment}",
              "image": "\${{ env.IMAGE }}:\${{ github.sha }}",
              "git_commit": "\${{ github.sha }}",
              "git_ref": "\${{ github.ref_name }}",
              "source": "ci"
            }'
`;
  }

  if (provider === "gitlab") {
    return `stages: [build, deploy]

variables:
  IMAGE: ${registry}/$CI_PROJECT_PATH

build:
  stage: build
  image: docker:latest
  services: [docker:dind]
  script:
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" ${registry}
    - docker build -t "$IMAGE:$CI_COMMIT_SHA" .
    - docker push "$IMAGE:$CI_COMMIT_SHA"

# Déclenchement du déploiement. Les champs git_* sont facultatifs : ils
# permettent de retrouver quel commit tourne en production.
deploy:
  stage: deploy
  image: curlimages/curl:latest
  only: [main]
  script:
    - |
      curl -sSf -X POST ${endpoint} \\
        -H "Authorization: Bearer $${TOKEN_SECRET}" \\
        -H "Content-Type: application/json" \\
        -d "{
          \\"environment\\": \\"${environment}\\",
          \\"image\\": \\"$IMAGE:$CI_COMMIT_SHA\\",
          \\"git_commit\\": \\"$CI_COMMIT_SHA\\",
          \\"git_ref\\": \\"$CI_COMMIT_REF_NAME\\",
          \\"source\\": \\"ci\\"
        }"
`;
  }

  return `# À exécuter depuis n'importe quel CI, après avoir publié votre image.
# Les champs git_* sont facultatifs : ils permettent de retrouver quel commit
# tourne en production.

curl -sSf -X POST ${endpoint} \\
  -H "Authorization: Bearer $${TOKEN_SECRET}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "environment": "${environment}",
    "image": "${registry}/votre-org/${appName}:$COMMIT_SHA",
    "git_commit": "'"$COMMIT_SHA"'",
    "git_ref": "'"$BRANCH"'",
    "source": "ci"
  }'
`;
}

/** Commande de vérification : confirme que le jeton et l'URL sont bons. */
export function verifyCommand(baseUrl: string) {
  return `curl -sSf ${baseUrl}/api/v1/auth/me \\
  -H "Authorization: Bearer $${TOKEN_SECRET}"`;
}
