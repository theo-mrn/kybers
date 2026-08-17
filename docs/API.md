# API du plan de contrôle

Kybers expose une API HTTP sur `:8080`. Elle sert le dashboard, mais rien ne la
lui réserve : une pipeline, un script ou un client généré l'appellent de la même
manière.

## Spécification

Le plan de contrôle sert sa propre spécification OpenAPI 3.1 :

```
GET /api/v1/openapi.json
```

Elle est produite au moment de l'appel, à partir de la table de routage et par
réflexion sur les modèles Go — elle ne peut donc décrire que ce qui existe. Une
spécification maintenue à part se serait périmée en quelques semaines.

Le fichier s'ouvre directement dans Postman, Bruno, Swagger Editor, ou alimente
un générateur de client :

```sh
# Client TypeScript
npx openapi-typescript http://localhost:8080/api/v1/openapi.json -o kybers.d.ts

# Client Go, Python, Java…
openapi-generator generate -i http://localhost:8080/api/v1/openapi.json \
  -g go -o ./client
```

Le dashboard en propose une lecture directe sur **`/doc-api`**, groupée par
domaine.

## Authentification

Tous les appels, sauf `/healthz` et la spécification elle-même, exigent un jeton
en en-tête :

```sh
curl -H "Authorization: Bearer $KYBERS_TOKEN" \
     http://localhost:8080/api/v1/apps
```

Les jetons se créent depuis le dashboard, page **Jetons**. Leur valeur n'est
affichée qu'à la création — Kybers n'en conserve qu'une empreinte.

Chaque jeton porte les permissions de son organisation : un jeton de CI n'a
besoin que de `app:deploy`, pas de `cluster:manage`.

## Déployer depuis une pipeline

C'est l'usage principal hors dashboard. Le workflow construit l'image, la
publie, puis appelle Kybers :

```sh
curl -sSf -X POST "$KYBERS_URL/api/v1/apps/$APP_ID/deploy" \
  -H "Authorization: Bearer $KYBERS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "environment": "production",
    "image": "ghcr.io/acme/api:sha-abc123",
    "git_commit": "abc123",
    "git_ref": "main",
    "source": "ci"
  }'
```

Kybers ne construit pas les images : c'est le rôle du CI. Le plan de contrôle
reçoit une référence d'image déjà publiée et demande au cluster de la déployer.

Les champs `git_commit`, `git_ref` et `source` sont facultatifs mais recommandés
— ils relient chaque déploiement au commit qui l'a produit, information que
Kybers ne peut pas déduire seul.

Les golden paths génèrent ce workflow automatiquement, avec le jeton déposé en
secret sur le dépôt.

## Documenter une nouvelle route

Les routes sont décrites dans `control-plane/internal/api/openapi.go` :

```go
"GET /api/v1/apps": {
    Summary:    "Liste les applications de l'organisation.",
    Tag:        "Applications",
    Returns:    models.App{},
    List:       true,
    Permission: "app:read",
},
```

La clé reprend exactement le motif passé au routeur. Deux tests veillent sur la
cohérence :

- `TestDocumentedRoutesExist` échoue si une route documentée a disparu du
  routeur — une description qui survit à sa route décrit un contrat qu'on ne
  peut plus honorer ;
- `TestUndocumentedRoutesAreReported` liste les routes sans description, sans
  faire échouer la suite : la documentation se complète au fil de l'eau, mais
  l'écart reste visible.

Les schémas de réponse viennent de la réflexion sur les modèles : ajouter un
champ à `models.App` le fait apparaître dans la documentation sans intervention.
Les corps de requête, eux, sont décrits à la main — les handlers utilisent des
structs anonymes, dont la réflexion ne tire aucun nom exploitable.
