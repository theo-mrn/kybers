# Guide de test bout en bout

Objectif : lancer le Control Plane en local, connecter un agent à un cluster
K3s/Minikube, et déployer une application via le dashboard.

Durée : ~15 minutes.

---

## Prérequis

| Outil | Version testée | Vérification |
|---|---|---|
| Go | 1.26+ | `go version` |
| Docker + Compose | 29+ | `docker compose version` |
| Node.js | 22+ | `node --version` |
| kubectl | 1.30+ | `kubectl version --client` |
| Helm | 3.x | `helm version` |
| Un cluster local | K3s / Minikube / k3d | `kubectl get nodes` |

Si vous n'avez pas encore de cluster :

```bash
# Option A — Minikube
minikube start --driver=docker

# Option B — k3d (K3s dans Docker)
k3d cluster create kybers --agents 1
```

Vérifiez que le contexte est bien actif :

```bash
kubectl get nodes
# NAME     STATUS   ROLES           AGE   VERSION
# master   Ready    control-plane   79d   v1.35.5+k3s1
```

---

## Étape 1 — Démarrer le Control Plane et PostgreSQL

Depuis la racine du monorepo :

```bash
docker compose up -d --build
```

Cela lance deux conteneurs :

- `kybers-postgres` — PostgreSQL 16 (port hôte **55432**, décalé pour éviter
  un conflit avec un PostgreSQL déjà installé)
- `kybers-control-plane` — API REST sur **8080**, gRPC sur **9090**

Les migrations SQL sont appliquées automatiquement au démarrage. Vérifiez :

```bash
docker compose logs control-plane | tail -5
# level=INFO msg="migrations appliquées"
# level=INFO msg="serveur gRPC démarré" addr=:9090
# level=INFO msg="serveur HTTP démarré" addr=:8080

curl -s localhost:8080/healthz
# {"agents":[],"status":"ok"}
```

`"agents":[]` est normal : aucun agent n'est encore connecté.

> La migration insère un cluster de démonstration nommé `local` avec le token
> `dev-cluster-token`. C'est ce couple que l'agent utilisera pour s'authentifier.

---

## Étape 2 — Lancer l'agent Data Plane

Deux modes possibles. **Le mode A est recommandé pour un premier test** : plus
rapide, et les logs de l'agent s'affichent directement dans le terminal.

### Mode A — Agent hors cluster (via kubeconfig)

L'agent tourne sur votre machine et pilote le cluster via votre kubeconfig.
C'est le mode le plus simple pour observer le flux.

```bash
go build -o bin/kybers-agent ./data-plane-agent/cmd/agent

CONTROL_PLANE_ADDR=localhost:9090 \
CLUSTER_ID=local \
CLUSTER_TOKEN=dev-cluster-token \
INSECURE=true \
./bin/kybers-agent
```

Sortie attendue :

```
level=INFO msg="client kubernetes: mode kubeconfig (hors cluster)"
level=INFO msg="cluster kubernetes détecté" version=v1.35.5+k3s1
level=INFO msg="connecté au control plane" addr=localhost:9090 cluster=local
```

### Mode B — Agent dans le cluster (via Helm)

C'est le mode de production : l'agent tourne dans le cluster, utilise le
ServiceAccount monté et ne dépend d'aucun kubeconfig.

```bash
# 1. Construire l'image (contexte = racine du monorepo)
docker build -f data-plane-agent/Dockerfile -t kybers/agent:dev .

# 2. Rendre l'image disponible dans le cluster
minikube image load kybers/agent:dev       # Minikube
# k3d image import kybers/agent:dev -c kybers   # k3d

# 3. Installer le chart
helm install kybers-agent ./data-plane-agent/charts/kybers-agent \
  --namespace kybers-system --create-namespace \
  --set controlPlane.addr=host.docker.internal:9090 \
  --set controlPlane.clusterId=local \
  --set auth.token=dev-cluster-token \
  --set controlPlane.insecure=true

# 4. Suivre les logs
kubectl logs -n kybers-system -l app.kubernetes.io/name=kybers-agent -f
```

> `host.docker.internal` permet au pod de joindre le Control Plane qui tourne
> sur votre machine hôte. Sur un K3s bare-metal, remplacez cette valeur par
> l'IP de votre machine sur le réseau du cluster.

### Vérifier la connexion

Dans les deux cas :

```bash
curl -s localhost:8080/healthz
# {"agents":["local"],"status":"ok"}
```

L'agent apparaît désormais dans la liste.

---

## Étape 3 — Lancer le dashboard

```bash
cd dashboard
cp .env.local.example .env.local
npm install
npm run dev
```

Ouvrez <http://localhost:3000>. Le bandeau doit afficher
**« 1 agent(s) connecté(s) : local »**.

---

## Étape 4 — Déployer une application

### Depuis le dashboard

1. Panneau **Nouvelle application** : nom `demo`, port `80`, puis
   *Créer l'application*.
2. Panneau **Déployer** :
   - Application : `demo`
   - Environnement : `staging`
   - Image : `nginx:alpine`
   - Replicas : `1`
   - Variables : `GREETING=bonjour`
3. Cliquez sur **Deploy**.

Le tableau des déploiements se rafraîchit automatiquement toutes les 5 s :
`pending` → `provisioning` → `running`.

### Ou en ligne de commande

```bash
APP=$(curl -s -X POST localhost:8080/api/v1/apps \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","container_port":80}')
APP_ID=$(echo "$APP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

curl -s -X PUT localhost:8080/api/v1/apps/$APP_ID/env \
  -H 'Content-Type: application/json' \
  -d '{"environment":"staging","vars":{"GREETING":"bonjour"}}'

curl -s -X POST localhost:8080/api/v1/apps/$APP_ID/deploy \
  -H 'Content-Type: application/json' \
  -d '{"environment":"staging","image":"nginx:alpine","replicas":1}'
```

---

## Étape 5 — Vérifier dans le cluster

```bash
kubectl get ns -l app.kubernetes.io/managed-by=kybers
# NAME           STATUS   AGE
# demo-staging   Active   32s

kubectl get deploy,svc,pods -n demo-staging
# deployment.apps/demo   1/1     1            1
# service/demo           ClusterIP   10.43.107.181   80/TCP
# pod/demo-5bb5d9c6b8-rmcgh   1/1     Running

# Les variables d'environnement ont bien été injectées
kubectl get deploy demo -n demo-staging \
  -o jsonpath='{.spec.template.spec.containers[0].env}'
# [{"name":"GREETING","value":"bonjour"}]
```

Tester l'application :

```bash
kubectl port-forward -n demo-staging svc/demo 8888:80
curl localhost:8888   # page d'accueil nginx
```

Consulter les logs remontés par l'agent :

```bash
DEP=$(curl -s localhost:8080/api/v1/deployments \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
curl -s "localhost:8080/api/v1/deployments/$DEP/logs?limit=5"
```

---

## Étape 6 — Tester l'isolation et le redéploiement

**Isolation par environnement** — un déploiement en `prod` crée un namespace
distinct, avec ses propres variables :

```bash
curl -s -X PUT localhost:8080/api/v1/apps/$APP_ID/env \
  -H 'Content-Type: application/json' \
  -d '{"environment":"prod","vars":{"TIER":"production"}}'

curl -s -X POST localhost:8080/api/v1/apps/$APP_ID/deploy \
  -H 'Content-Type: application/json' \
  -d '{"environment":"prod","image":"nginx:alpine","replicas":1,"host":"demo.exemple.fr"}'

kubectl get ns -l app.kubernetes.io/managed-by=kybers
# demo-prod      Active
# demo-staging   Active
```

Les variables ne fuient pas d'un environnement à l'autre :

```bash
kubectl get deploy demo -n demo-prod \
  -o jsonpath='{.spec.template.spec.containers[0].env}'
# [{"name":"TIER","value":"production"}]   ← pas de GREETING
```

Comme un `host` a été fourni, un Ingress est créé :

```bash
kubectl get ingress -n demo-prod
# demo   traefik   demo.exemple.fr   80, 443
```

**Redéploiement** — relancer avec une autre image met à jour en place :

```bash
curl -s -X POST localhost:8080/api/v1/apps/$APP_ID/deploy \
  -H 'Content-Type: application/json' \
  -d '{"environment":"staging","image":"nginx:1.27-alpine","replicas":2}'

kubectl get deploy demo -n demo-staging \
  -o jsonpath='{.spec.replicas} replicas / {.spec.template.spec.containers[0].image}'
# 2 replicas / nginx:1.27-alpine
```

---

## Étape 7 — Vérifier la résilience

L'agent doit survivre à une coupure du Control Plane :

```bash
docker compose stop control-plane
# Logs agent : level=WARN msg="connexion perdue, nouvelle tentative" dans=5s

docker compose start control-plane
# Logs agent : level=INFO msg="connecté au control plane"
```

Un déploiement créé pendant que l'agent est arrêté reste en `pending` et part
automatiquement dès sa reconnexion — rien n'est perdu.

---

## Nettoyage

```bash
kubectl delete ns demo-staging demo-prod --ignore-not-found
helm uninstall kybers-agent -n kybers-system   # si mode B
docker compose down -v                          # -v supprime aussi la base
```

---

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `Bind for 0.0.0.0:5432 failed` | Un PostgreSQL local occupe le port | Déjà géré : le compose utilise **55432** côté hôte |
| `"agents":[]` malgré l'agent lancé | Token ou `CLUSTER_ID` incorrect | Doivent valoir `dev-cluster-token` / `local` |
| `enregistrement refusé` | Le couple (cluster, token) n'existe pas en base | `docker compose down -v && docker compose up -d` |
| Déploiement bloqué en `pending` | Aucun agent connecté | Vérifier `/healthz` ; le dispatcher n'envoie rien sans agent |
| Déploiement en `failed`, timeout replicas | Image introuvable dans le cluster | `kubectl describe pod -n <ns>` ; charger l'image ou utiliser une image publique |
| Agent : `configuration kubernetes introuvable` | Pas de kubeconfig en mode A | `export KUBECONFIG=~/.kube/config` |
| Pod agent en `ImagePullBackOff` | Image absente du cluster | `minikube image load kybers/agent:dev` |
