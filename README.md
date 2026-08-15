# Kybers

Prototype de plateforme **PaaS self-hosted et souveraine** — l'expérience Vercel
ou Render, mais les applications s'exécutent sur *votre* cluster Kubernetes,
on-premise ou multi-cloud.

Un développeur connecte un dépôt, clique sur **Deploy**, et l'application est
provisionnée dans un namespace isolé de son cluster. Aucune donnée applicative
ne quitte l'infrastructure du client.

---

## Architecture

```
┌────────────────────────── VOTRE SaaS ───────────────────────────┐
│                                                                 │
│   Dashboard Next.js  ──REST──▶  Control Plane (Go)              │
│   (App Router, RSC)             ├── API REST        :8080       │
│                                 ├── Serveur gRPC    :9090       │
│                                 └── Dispatcher (file d'attente) │
│                                          │                      │
│                                  PostgreSQL 16                  │
│                          (users, apps, env vars, deployments)   │
└──────────────────────────────────┬──────────────────────────────┘
                                   │
                    stream gRPC bidirectionnel TLS
                   ◀── initié par l'agent (SORTANT) ──
                                   │
┌──────────────────────────────────┴──────────────────────────────┐
│                    CLUSTER KUBERNETES DU CLIENT                 │
│                                                                 │
│   Agent Kybers (Go + client-go)                                 │
│      │  reçoit les ordres, applique, remonte statut et logs     │
│      ▼                                                          │
│   ns: billing-api-staging        ns: billing-api-prod           │
│   ├── Deployment                 ├── Deployment                 │
│   ├── Service (ClusterIP)        ├── Service                    │
│   └── Ingress (HTTPS)            └── Ingress (HTTPS)            │
└─────────────────────────────────────────────────────────────────┘
```

### Le principe clé : la connexion sortante

L'agent **initie** la connexion vers le Control Plane et maintient le stream
gRPC ouvert. Le Control Plane pousse les ordres de déploiement sur ce canal
déjà établi.

Conséquence : **aucun port entrant à ouvrir** sur le cluster client, aucune
règle de pare-feu entrante, aucune adresse IP publique. C'est ce qui rend
l'installation acceptable dans un environnement d'entreprise verrouillé.

### Le cycle de vie d'un déploiement

```
POST /apps/{id}/deploy
        │
        ▼
   status: pending ────────┐  L'API répond immédiatement (202).
        │                  │  Si aucun agent n'est connecté, la demande
        ▼                  │  reste ici jusqu'à sa reconnexion.
   Dispatcher (2s)         │
   ClaimPendingDeployments │
        │                  │
        ▼                  │  Échec d'envoi → retour en pending
   status: dispatched ─────┘
        │  push sur le stream gRPC
        ▼
   Agent : Namespace → Deployment → Service → Ingress
        │
        ▼
   status: provisioning ──▶ running (ou failed)
        │
        └──▶ logs des pods remontés au Control Plane
```

`ClaimPendingDeployments` utilise `UPDATE … RETURNING` avec `FOR UPDATE SKIP
LOCKED` : plusieurs instances du Control Plane peuvent tourner en parallèle
sans qu'un déploiement soit traité deux fois.

---

## Arborescence

```
kybers/
├── go.work                        Workspace Go (proto + control-plane + agent)
├── docker-compose.yml             Control Plane + PostgreSQL en local
├── Makefile
│
├── proto/                         Contrat gRPC partagé
│   ├── kybers/v1/agent.proto      Source de vérité du protocole
│   └── gen/kybers/v1/             Code Go généré (buf)
│
├── control-plane/                 SaaS central
│   ├── cmd/server/main.go         Point d'entrée : HTTP + gRPC + dispatcher
│   ├── internal/
│   │   ├── api/                   API REST (net/http, routage Go 1.22+)
│   │   ├── db/                    Accès PostgreSQL (pgx) + migrations
│   │   ├── grpcserver/            Service gRPC des agents + dispatcher
│   │   └── models/                Entités métier
│   └── Dockerfile
│
├── data-plane-agent/              Agent installé chez le client
│   ├── cmd/agent/main.go
│   ├── internal/
│   │   ├── client/                Connexion sortante, reconnexion, ordres
│   │   └── k8s/                   Traduction ordre → ressources Kubernetes
│   ├── charts/kybers-agent/       Chart Helm (RBAC, Secret, Deployment)
│   └── Dockerfile
│
├── dashboard/                     Next.js 16 (App Router, Tailwind 4)
│   └── src/
│       ├── app/
│       │   ├── page.tsx           Déploiements actifs + historique
│       │   ├── apps/              Liste et détail d'application (onglets)
│       │   ├── registries/        Connexion Docker Hub + catalogue d'images
│       │   └── actions.ts         Server Actions (déploiement, cycle de vie…)
│       ├── components/            Formulaires (Client Components)
│       └── lib/api.ts             Client de l'API, côté serveur uniquement
│
└── docs/
    ├── GETTING_STARTED.md         Guide de test bout en bout
    └── RUNTIME.md                 Configuration d'exécution et cycle de vie
```

---

## Démarrage rapide

```bash
# 1. Control Plane + PostgreSQL
docker compose up -d --build

# 2. Agent connecté à votre cluster local
go build -o bin/kybers-agent ./data-plane-agent/cmd/agent
CONTROL_PLANE_ADDR=localhost:9090 CLUSTER_ID=local \
CLUSTER_TOKEN=dev-cluster-token INSECURE=true ./bin/kybers-agent

# 3. Dashboard
cd dashboard && cp .env.local.example .env.local && npm install && npm run dev
```

Puis <http://localhost:3000>.

Guides :
- **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** — installation, Helm, premier déploiement
- **[docs/RUNTIME.md](docs/RUNTIME.md)** — probes, secrets, registries privés, scale, rollback, diagnostic
- **[docs/AGENT.md](docs/AGENT.md)** — l'agent en détail : rôle, installation, permissions, dépannage

---

## API REST

### Applications & configuration

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/healthz` | État du service et agents connectés |
| `GET` | `/api/v1/apps` | Liste des applications |
| `POST` | `/api/v1/apps` | Créer une application |
| `GET` | `/api/v1/apps/{id}` | Détail d'une application |
| `GET` \| `PUT` | `/api/v1/apps/{id}/config` | Configuration d'exécution (probes, ressources, HPA, quotas, sécurité) |
| `GET` \| `PUT` | `/api/v1/apps/{id}/env` | Variables non sensibles (→ ConfigMap) |
| `DELETE` | `/api/v1/apps/{id}/env/{key}` | Supprimer une variable |
| `GET` \| `PUT` | `/api/v1/apps/{id}/secrets` | Variables sensibles (→ Secret). `GET` ne renvoie que les **noms** |
| `DELETE` | `/api/v1/apps/{id}/secrets/{key}` | Supprimer un secret |

### Déploiement & cycle de vie

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/api/v1/apps/{id}/deploy` | **Mettre un déploiement en file d'attente** (crée une révision) |
| `GET` | `/api/v1/apps/{id}/deployments` | Historique des révisions |
| `GET` | `/api/v1/deployments` | Tous les déploiements |
| `GET` | `/api/v1/deployments/{id}` | Détail (statut, cause d'échec, révision) |
| `POST` | `/api/v1/deployments/{id}/scale` | Changer le nombre de replicas |
| `POST` | `/api/v1/deployments/{id}/stop` | Arrêter (0 replica, configuration conservée) |
| `POST` | `/api/v1/deployments/{id}/start` | Redémarrer une application arrêtée |
| `POST` | `/api/v1/deployments/{id}/restart` | Rolling restart des pods |
| `POST` | `/api/v1/deployments/{id}/rollback` | Revenir à cette révision (en crée une nouvelle) |
| `DELETE` | `/api/v1/deployments/{id}` | Supprimer l'app (`?namespace=true` = tout l'environnement) |

### Observabilité & registries

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/v1/deployments/{id}/logs` | Logs remontés par l'agent |
| `POST` | `/api/v1/deployments/{id}/logs/follow` | Démarrer/arrêter le streaming continu |
| `GET` | `/api/v1/deployments/{id}/events` | Events Kubernetes (diagnostic) |
| `GET` \| `POST` | `/api/v1/registries` | Registries privés (mot de passe chiffré, jamais relu) |
| `DELETE` | `/api/v1/registries/{id}` | Supprimer un registry |
| `POST` | `/api/v1/registries/test` | Valider des identifiants sans les enregistrer |
| `GET` | `/api/v1/registries/{id}/repositories` | Dépôts du compte (Docker Hub) |
| `GET` | `/api/v1/registries/{id}/tags?repository=…` | Tags d'un dépôt |
| `GET` | `/api/v1/clusters` | Clusters connectés |

Authentification : `Authorization: Bearer <API_TOKEN>`. Si `API_TOKEN` est vide
côté serveur, l'authentification est désactivée — **développement local
uniquement**.

---

## Configuration

### Control Plane

| Variable | Défaut | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://kybers:kybers@localhost:5432/kybers?sslmode=disable` | DSN PostgreSQL |
| `HTTP_ADDR` | `:8080` | API REST |
| `GRPC_ADDR` | `:9090` | Serveur gRPC des agents |
| `API_TOKEN` | *(vide)* | Jeton de l'API REST ; vide = auth désactivée |
| `ENCRYPTION_KEY` | *(clé de dev)* | Chiffre secrets et mots de passe de registry (AES-256-GCM). **La changer invalide les secrets déjà stockés** |

### Agent

| Variable | Défaut | Description |
|---|---|---|
| `CONTROL_PLANE_ADDR` | `localhost:9090` | Adresse du Control Plane |
| `CLUSTER_ID` | `local` | Identifiant du cluster, doit exister en base |
| `CLUSTER_TOKEN` | `dev-cluster-token` | Secret d'authentification |
| `INSECURE` | `true` | `true` = gRPC en clair ; **passer à `false` en production** |
| `KUBECONFIG` | *(auto)* | Ignoré en mode in-cluster |

---

## Tests

```bash
make test                        # tests Go (isolation, idempotence, RFC 1123)
cd dashboard && npm run build    # typecheck + build du dashboard
helm lint data-plane-agent/charts/kybers-agent
```

Validé sur un cluster **K3s v1.35.5** à deux nœuds : création de namespace,
déploiement, redéploiement avec changement d'image et de replicas, isolation
des variables entre `staging` et `prod`, Ingress Traefik avec TLS, et remontée
des logs applicatifs.

---

## Ce qui fonctionne

**Déploiement**
- Application depuis une image d'un registry public ou **privé** (imagePullSecret généré)
- Isolation stricte : un namespace par couple (application, environnement)
- Deployment + Service + Ingress TLS, appliqués de façon idempotente
- Variables **non sensibles** en ConfigMap, **sensibles** en Secret — jamais inscrites dans le PodSpec
- Chiffrement AES-256-GCM au repos des secrets et mots de passe de registry

**Exécution**
- Sondes liveness / readiness / startup (HTTP, TCP, exec)
- Requests & limits par application
- Autoscaling horizontal (HPA sur CPU), retiré automatiquement si désactivé
- ResourceQuota et NetworkPolicy par environnement
- Durcissement opt-in : `runAsNonRoot`, `runAsUser`, `readOnlyRootFilesystem`

**Cycle de vie**
- Scale, stop (0 replica, configuration conservée), start, rolling restart
- Révisions numérotées et **rollback** vers une révision antérieure
- Suppression de l'application seule ou de tout l'environnement

**Dashboard**
- Connexion d'un compte Docker Hub, avec validation des identifiants à la saisie
- Parcours du catalogue : dépôts publics et privés, tags, filtre par nom
- Un clic sur un tag pré-remplit le formulaire de déploiement
- Page par application : configuration, variables, secrets, logs, historique
- Pilotage complet depuis l'UI : scale, stop/start, restart, rollback, suppression

**Observabilité**
- Streaming des logs en continu, y compris pour les pods créés après coup
- Events Kubernetes remontés au Control Plane
- Diagnostic d'échec explicite : `ImagePullBackOff`, `CrashLoopBackOff`,
  `OOMKilled`, `Unschedulable`, détecté sans attendre le timeout
- Détection fiable du rollout : un déploiement dont la nouvelle image ne démarre
  pas est marqué `failed`, même si l'ancienne version continue de servir

---

## Limites connues

- **Pas de build** — la plateforme déploie une image existante ; il n'y a pas de
  chaîne `git clone → image`. C'est un choix de périmètre assumé pour l'instant.
- **Authentification** — la table `users` existe mais le SaaS utilise un jeton
  statique. Il faut OIDC/SSO et un vrai modèle multi-tenant.
- **mTLS agent ↔ Control Plane** — le transport TLS est prêt côté agent
  (`INSECURE=false`), mais le Control Plane ne présente pas encore de certificat
  ni ne vérifie l'identité de l'agent par certificat.
- **Rollback partiel** — l'image et les replicas sont restaurés, mais la
  configuration figée dans `config_snapshot` n'est pas encore réappliquée.
- **Catalogue d'images** — seul Docker Hub est implémenté. Le Registry API v2
  n'expose pas de catalogue par compte : lister les dépôts passe par l'API
  propriétaire de chaque fournisseur (GHCR, Quay… restent à ajouter).
- **Purge des logs** — les logs et events s'accumulent en base sans rétention.
