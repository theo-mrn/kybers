# Configuration d'exécution et cycle de vie

Ce guide couvre tout ce qui entoure l'exécution d'une application : santé,
ressources, sécurité, secrets, et pilotage après déploiement.

Prérequis : la stack tourne et un agent est connecté (voir
[GETTING_STARTED.md](GETTING_STARTED.md)).

```bash
API=localhost:8080
APP_ID=$(curl -s -X POST $API/api/v1/apps \
  -H 'Content-Type: application/json' \
  -d '{"name":"boutique","container_port":80}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
```

---

## 1. Registry privé

Les identifiants sont chiffrés (AES-256-GCM) avant d'être stockés. L'API ne les
renvoie jamais : seul l'agent les reçoit, pour construire l'`imagePullSecret`.

```bash
REG_ID=$(curl -s -X POST $API/api/v1/registries \
  -H 'Content-Type: application/json' \
  -d '{"name":"ghcr","server":"ghcr.io","username":"bot","password":"ghp_xxx"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# Rattacher le registry à un environnement
curl -s -X PUT $API/api/v1/apps/$APP_ID/config \
  -H 'Content-Type: application/json' \
  -d "{\"environment\":\"prod\",\"registry_id\":\"$REG_ID\"}"
```

L'agent crée alors un Secret `kubernetes.io/dockerconfigjson` dans le namespace
et le référence dans le Deployment. Retirer `registry_id` supprime le secret au
déploiement suivant.

---

## 2. Sondes de santé

Sans readiness probe, un pod est considéré prêt dès qu'il démarre — même si
l'application n'écoute pas encore. C'est la sonde qui rend le statut `running`
digne de confiance.

```bash
curl -s -X PUT $API/api/v1/apps/$APP_ID/config \
  -H 'Content-Type: application/json' -d '{
  "environment": "staging",
  "readiness_probe": {"type":"http","path":"/healthz","period_seconds":5},
  "liveness_probe":  {"type":"tcp","initial_delay_seconds":15},
  "startup_probe":   {"type":"exec","command":["cat","/tmp/ready"]}
}'
```

| Type | Champs utilisés |
|---|---|
| `http` | `path`, `port` (0 = port du conteneur) |
| `tcp` | `port` |
| `exec` | `command` (tableau) |

Champs communs : `initial_delay_seconds`, `period_seconds`, `timeout_seconds`,
`failure_threshold`. Type omis ou `"none"` = sonde désactivée.

---

## 3. Ressources et autoscaling

```bash
curl -s -X PUT $API/api/v1/apps/$APP_ID/config \
  -H 'Content-Type: application/json' -d '{
  "environment": "staging",
  "cpu_request": "100m", "memory_request": "128Mi",
  "cpu_limit": "1",      "memory_limit": "512Mi",
  "autoscaling_enabled": true,
  "autoscaling_min": 2, "autoscaling_max": 10,
  "autoscaling_cpu_percent": 70
}'
```

Quand l'autoscaling est actif, l'agent ne réécrit pas le nombre de replicas lors
d'un redéploiement : le HPA garde la main. Le désactiver supprime le HPA.

> Le HPA nécessite `metrics-server` dans le cluster. Sans lui, l'objet est créé
> mais reste inactif.

---

## 4. Variables et secrets

Deux chemins distincts, et c'est important : les variables simples finissent
dans une ConfigMap, les secrets dans un Secret Kubernetes. Dans les deux cas,
elles sont injectées par `envFrom` — jamais écrites en clair dans le PodSpec.

```bash
# Non sensibles
curl -s -X PUT $API/api/v1/apps/$APP_ID/env \
  -H 'Content-Type: application/json' \
  -d '{"environment":"staging","vars":{"LOG_LEVEL":"debug"}}'

# Sensibles : chiffrées en base
curl -s -X PUT $API/api/v1/apps/$APP_ID/secrets \
  -H 'Content-Type: application/json' \
  -d '{"environment":"staging","vars":{"DB_PASSWORD":"tr3s-s3cret"}}'

# Relecture : les NOMS seulement
curl -s "$API/api/v1/apps/$APP_ID/secrets?environment=staging"
# {"keys":["DB_PASSWORD"]}
```

Vérification que rien ne fuite dans le PodSpec :

```bash
kubectl get deploy boutique -n boutique-staging \
  -o jsonpath='{.spec.template.spec.containers[0].env}'
# (vide — tout passe par envFrom)
```

---

## 5. Sécurité du namespace

```bash
curl -s -X PUT $API/api/v1/apps/$APP_ID/config \
  -H 'Content-Type: application/json' -d '{
  "environment": "prod",
  "network_policy": true,
  "quota_cpu": "4", "quota_memory": "8Gi", "quota_pods": 20,
  "run_as_non_root": true, "run_as_user": 10001,
  "read_only_root_fs": true
}'
```

**NetworkPolicy** — seuls l'ingress-controller et les pods du même namespace
peuvent joindre l'application. Les sorties restent ouvertes (DNS, bases, API).

**ResourceQuota** — borne la consommation totale de l'environnement.

**Durcissement** — `run_as_non_root`, `run_as_user` et `read_only_root_fs` sont
**désactivés par défaut**, volontairement : la plupart des images publiques
(nginx, postgres, redis) démarrent en root et échoueraient avec un
`CreateContainerConfigError`. Activez-les pour vos propres images.

`allowPrivilegeEscalation: false` est en revanche toujours appliqué : il bloque
l'escalade de privilèges sans empêcher aucune image légitime de démarrer.

---

## 6. Piloter une application déployée

```bash
DEP=$(curl -s "$API/api/v1/apps/$APP_ID/deployments?environment=staging" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

# Monter à 4 replicas
curl -s -X POST $API/api/v1/deployments/$DEP/scale \
  -H 'Content-Type: application/json' -d '{"replicas":4}'

# Arrêter — 0 replica, mais Service, Ingress et configuration conservés
curl -s -X POST $API/api/v1/deployments/$DEP/stop -d '{}'

# Redémarrer
curl -s -X POST $API/api/v1/deployments/$DEP/start \
  -H 'Content-Type: application/json' -d '{"replicas":2}'

# Rolling restart (sans changer la configuration)
curl -s -X POST $API/api/v1/deployments/$DEP/restart -d '{}'

# Supprimer l'application (le namespace survit)
curl -s -X DELETE "$API/api/v1/deployments/$DEP"

# Supprimer tout l'environnement
curl -s -X DELETE "$API/api/v1/deployments/$DEP?namespace=true"
```

`stop` diffère de `delete` : l'application ne consomme plus de ressources mais
son URL, ses variables et son historique restent intacts.

---

## 7. Révisions et rollback

Chaque déploiement crée une révision numérotée par environnement.

```bash
curl -s "$API/api/v1/apps/$APP_ID/deployments?environment=staging" \
  | python3 -c '
import sys,json
for d in json.load(sys.stdin):
    rb = " (rollback)" if d.get("rolled_back_from") else ""
    print("rev%-3s %-10s %s%s" % (d["revision"], d["status"], d["image"], rb))'
```

```
rev8   running    nginx:alpine (rollback)
rev7   failed     nginx:fantome-42
rev6   running    nginx:alpine
```

Revenir à une révision antérieure :

```bash
REV6=$(...)  # id de la révision 6
curl -s -X POST $API/api/v1/deployments/$REV6/rollback -d '{}'
```

Le rollback **crée une nouvelle révision** (rev8) plutôt que de réécrire
l'historique : la trace de ce qui s'est passé est préservée.

---

## 8. Diagnostic d'un échec

L'agent identifie la cause sans attendre l'expiration du délai.

```bash
# Déploiement d'une image qui n'existe pas
curl -s -X POST $API/api/v1/apps/$APP_ID/deploy \
  -H 'Content-Type: application/json' \
  -d '{"environment":"staging","image":"nginx:fantome-42","replicas":1}'

curl -s $API/api/v1/deployments/$DEP | python3 -m json.tool | grep -E 'status|reason'
# "status": "failed",
# "reason": "ErrImagePull: image \"nginx:fantome-42\" introuvable ou registry inaccessible"
```

Causes détectées : `ImagePullBackOff`, `ErrImagePull`, `InvalidImageName`,
`CrashLoopBackOff`, `CreateContainerConfigError`, `OOMKilled`, `Unschedulable`.

Pendant un rolling update, l'ancienne version continue de servir le trafic. Le
statut reflète bien la **nouvelle** révision : un échec n'est pas masqué par les
pods sains de la version précédente.

Les events Kubernetes complètent le diagnostic :

```bash
curl -s "$API/api/v1/deployments/$DEP/events?limit=10" | python3 -c '
import sys,json
for e in json.load(sys.stdin):
    print(e["type"], "|", e["reason"], "|", e["message"][:70])'
```

---

## 9. Logs en continu

```bash
# Démarrer le suivi
curl -s -X POST $API/api/v1/deployments/$DEP/logs/follow \
  -H 'Content-Type: application/json' -d '{"follow":true}'

# Lire ce qui remonte
curl -s "$API/api/v1/deployments/$DEP/logs?limit=50"

# Arrêter
curl -s -X POST $API/api/v1/deployments/$DEP/logs/follow \
  -H 'Content-Type: application/json' -d '{"follow":false}'
```

Le suivi prend en compte les pods créés après son démarrage (scale up,
redémarrage) et s'arrête automatiquement si l'agent se déconnecte.

---

## Dépannage

| Symptôme | Cause | Solution |
|---|---|---|
| `CreateContainerConfigError: runAsNonRoot` | L'image tourne en root | Passer `run_as_non_root: false` (défaut) |
| `chown ... Operation not permitted` | Capabilities retirées | Idem : le drop des capabilities suit `run_as_non_root` |
| Pod `Pending`, `Unschedulable` | ResourceQuota atteint | Relever `quota_cpu`/`quota_memory`/`quota_pods` |
| `ImagePullBackOff` sur registry privé | Identifiants absents ou faux | Vérifier `registry_id` dans la config de l'environnement |
| HPA créé mais inactif | `metrics-server` absent | L'installer dans le cluster |
| Secrets illisibles après redémarrage | `ENCRYPTION_KEY` modifiée | Restaurer la clé précédente, ou redéfinir les secrets |
| Déploiement `failed` mais l'app répond | Normal : l'ancienne révision sert encore | Consulter `reason` puis faire un rollback |
