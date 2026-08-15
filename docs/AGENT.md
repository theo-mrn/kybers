# L'agent Kybers — rapport complet

Version de l'agent : **0.3.0**
Document rédigé à partir du code, pas d'une spécification.

---

## 1. À quoi il sert

L'agent est la moitié « Data Plane » de Kybers. Il est le **seul** composant qui
touche à votre cluster Kubernetes.

Le Control Plane (API, base de données, dashboard) ne parle jamais directement à
Kubernetes. Il enregistre des intentions — « déployer cette image », « scaler à
3 replicas » — et l'agent les traduit en ressources Kubernetes réelles. En
retour, il remonte ce qu'il observe : état des pods, logs, events, consommation.

Cette séparation a une conséquence directe : **votre cluster n'a aucun port
ouvert vers l'extérieur**. C'est l'agent qui initie la connexion, vers le
Control Plane. Aucune règle de pare-feu entrante, aucune IP publique, aucun
kubeconfig à confier à un tiers.

```
        VOTRE INFRASTRUCTURE                    LE SAAS
   ┌────────────────────────────┐        ┌──────────────────┐
   │  Cluster Kubernetes        │        │  Control Plane   │
   │                            │        │  ├── API REST    │
   │   ┌──────────┐             │        │  ├── gRPC :9090  │
   │   │  agent   │─────────────┼───────▶│  └── PostgreSQL  │
   │   └────┬─────┘  connexion  │        └──────────────────┘
   │        │        SORTANTE   │
   │        ▼                   │        Le Control Plane ne peut
   │   applications déployées   │        PAS joindre le cluster.
   └────────────────────────────┘
```

---

## 2. Où il vit

**Un agent par cluster**, installé dans le namespace `kybers-system`.

C'est un Deployment à **une seule réplique** : deux instances traiteraient les
mêmes ordres en double. La stratégie est `Recreate` — l'ancien pod est arrêté
avant que le nouveau démarre.

L'agent n'expose **aucun Service**. Le seul port ouvert est `8081`, uniquement
pour les sondes de santé lues par le kubelet. Rien n'écoute pour recevoir des
commandes : elles arrivent par le stream gRPC sortant.

Il tourne sous un ServiceAccount dédié, avec un ClusterRole (détaillé au §7).

---

## 3. Installation

### En une commande

Depuis le dashboard, page **Infrastructure** → « Enregistrer un cluster ». La
commande affichée contient déjà le jeton :

```bash
curl -sSL https://<control-plane>/install.sh | \
  KYBERS_TOKEN=<jeton> KYBERS_CLUSTER=<nom> sh
```

À exécuter depuis une machine ayant un accès `kubectl` au cluster à piloter.

Le script vérifie les prérequis **avant** d'installer quoi que ce soit :

| Vérification | Pourquoi |
|---|---|
| `kubectl` présent | requis pour joindre le cluster |
| `helm` présent | l'agent est distribué par chart |
| cluster joignable | `kubectl cluster-info` doit répondre |
| droits d'administration | créer des namespaces et ClusterRole les exige |

Il installe ensuite le chart, **attend la connexion réelle** de l'agent, et la
confirme. En cas d'échec il affiche l'état des pods et la commande de
diagnostic — jamais un « succès » sur un agent qui ne se connecte pas.

### Par Helm directement

```bash
helm install kybers-agent \
  oci://registry-1.docker.io/maxwellfaraday/kybers-agent \
  --namespace kybers-system --create-namespace \
  --set controlPlane.addr=<control-plane>:9090 \
  --set controlPlane.clusterId=<nom> \
  --set auth.token=<jeton>
```

Le chart refuse de s'installer si `controlPlane.addr` ou le jeton manquent, et
si l'adresse pointe sur `localhost` — depuis un pod, cette adresse désigne le
pod lui-même, pas votre machine.

### Artefacts publiés

| Élément | Référence |
|---|---|
| Image | `maxwellfaraday/kybers-agent:dev` — **amd64 + arm64** |
| Chart | `oci://registry-1.docker.io/maxwellfaraday/kybers-agent:0.1.0` |

### Désinstallation

```bash
helm uninstall kybers-agent -n kybers-system
```

Les applications déployées ne sont **pas** supprimées : elles continuent de
tourner, simplement plus pilotables depuis Kybers.

---

## 4. Ce qu'il fait concrètement

### Ordres reçus du Control Plane

| Ordre | Effet |
|---|---|
| `DeployCommand` | Crée ou met à jour toutes les ressources d'une application |
| `ScaleCommand` | Change le nombre de replicas (0 = arrêt sans suppression) |
| `RestartCommand` | Rolling restart, sans changer la configuration |
| `DeleteCommand` | Supprime l'application, ou tout le namespace |
| `LogStreamCommand` | Démarre/arrête le suivi des logs en continu |
| `SetMetricsSourceCommand` | Impose metrics-server ou Prometheus |

### Ressources créées pour une application

Pour chaque déploiement, dans l'ordre :

1. **Namespace** — `<application>-<environnement>`, ex. `billing-api-prod`
2. **ResourceQuota** — si des quotas sont configurés ; supprimé sinon
3. **ConfigMap** — variables non sensibles
4. **Secret** — variables sensibles, injectées par `envFrom`
5. **Secret dockerconfigjson** — si un registry privé est lié
6. **Deployment** — image, replicas, sondes, ressources, sécurité
7. **Service** — ClusterIP, port 80 → port du conteneur
8. **Ingress** — si un hostname est défini, avec TLS si le domaine est maîtrisé
9. **HorizontalPodAutoscaler** — si l'autoscaling est activé ; supprimé sinon
10. **NetworkPolicy** — si l'isolation est activée ; supprimée sinon

Toutes les opérations sont **idempotentes** : réappliquer le même déploiement ne
casse rien. Les objets portent le label `app.kubernetes.io/managed-by=kybers`.

**Isolation** — un namespace par couple (application, environnement). Les
variables de `staging` ne fuient jamais vers `prod`.

**Secrets** — jamais inscrits dans le PodSpec, seulement référencés via
`envFrom`. Un `kubectl get deploy -o yaml` ne les révèle pas.

### Informations remontées

| Message | Fréquence |
|---|---|
| `Register` | à la connexion |
| `Heartbeat` | toutes les 15 s |
| `DeploymentStatus` | à chaque étape d'un déploiement |
| `LogChunk` | en fin de déploiement, ou en continu si le suivi est actif |
| `PodEvent` | events Kubernetes lors d'un déploiement |
| `CommandResult` | après chaque commande de cycle de vie |
| `ClusterInfo` | toutes les minutes |
| `UsageReport` | toutes les 30 s |

---

## 5. Comportements notables

Ces comportements viennent tous de problèmes rencontrés en conditions réelles.

**Détection d'échec sans attendre le timeout.** Un `ImagePullBackOff` ou un
`CrashLoopBackOff` est diagnostiqué en quelques secondes, avec une cause
lisible : « image introuvable ou registry inaccessible ». Causes reconnues :
`ImagePullBackOff`, `ErrImagePull`, `InvalidImageName`, `CrashLoopBackOff`,
`CreateContainerConfigError`, `OOMKilled`, `Unschedulable`, conteneur qui se
termine immédiatement.

**Suivi de la bonne révision.** Pendant une mise à jour progressive, les anciens
pods restent prêts. L'agent ne compte que les pods de la révision courante,
identifiés par annotation : un déploiement dont la nouvelle image ne démarre pas
est marqué `failed`, même si l'ancienne version continue de servir le trafic.

**Fenêtre de stabilité de 20 s.** Une image sans processus durable démarre, passe
par `Ready`, puis se termine. L'agent observe les pods 20 secondes après qu'ils
soient prêts avant de déclarer le succès.

**Durcissement opt-in.** `runAsNonRoot`, `readOnlyRootFilesystem` et le retrait
des capabilities sont **désactivés par défaut** : la plupart des images publiques
(nginx, postgres, redis) tournent en root et échoueraient. Seul
`allowPrivilegeEscalation: false` est toujours appliqué.

**NetworkPolicy adaptative.** Les namespaces de l'ingress-controller sont
*détectés*, pas supposés : `kube-system` sur K3s, `ingress-nginx`, `traefik`,
`istio-system`… Une liste en dur bloquerait le trafic sur les distributions non
prévues.

**Reconnexion résiliente.** Backoff exponentiel de 5 s à 60 s. Une coupure du
Control Plane ne tue jamais l'agent, et les déploiements créés pendant la
coupure partent dès la reconnexion.

---

## 6. Santé et supervision

L'agent expose deux endpoints sur le port `8081`, lus par Kubernetes :

| Endpoint | Sonde | Signification |
|---|---|---|
| `/healthz` | liveness + startup | l'agent n'est pas figé |
| `/readyz` | readiness | l'agent est connecté au Control Plane |

**Distinction importante** : une déconnexion ne déclenche **pas** de
redémarrage. L'agent reconnecte seul, et une liveness basée sur la connexion
ferait redémarrer tous les agents de tous les clusters dès que le Control Plane
redémarre. Seul un silence prolongé — 5 minutes sans aucun échange, signe d'un
blocage réel — provoque un redémarrage.

Un agent déconnecté apparaît donc `0/1 Ready` dans `kubectl get pods` sans être
tué : le problème est visible sans être aggravé.

```bash
kubectl get pods -n kybers-system
kubectl logs -n kybers-system -l app.kubernetes.io/name=kybers-agent --tail=30
kubectl port-forward -n kybers-system deploy/kybers-agent-kybers-agent 8081:8081
curl localhost:8081/healthz
```

La réponse JSON contient l'état de connexion, la dernière erreur et le temps
écoulé depuis le dernier échange.

---

## 7. Permissions requises

L'agent crée des namespaces et y déploie : ces droits sont nécessairement
**à l'échelle du cluster**.

| Ressources | Verbes | Usage |
|---|---|---|
| `namespaces` | get, list, watch, create, delete | un namespace par environnement |
| `services`, `configmaps`, `secrets` | complet | exposition et configuration |
| `resourcequotas` | complet | quotas par environnement |
| `pods` | get, list, watch | état des déploiements |
| `pods/log` | get | remontée des logs |
| `deployments`, `replicasets` | complet | les applications elles-mêmes |
| `ingresses`, `networkpolicies` | complet | exposition et isolation |
| `horizontalpodautoscalers` | complet | autoscaling |
| `nodes` | get, list | état de l'infrastructure (lecture seule) |
| `ingressclasses`, `storageclasses` | get, list | capacités du cluster |
| `metrics.k8s.io` (nodes, pods) | get, list | consommation CPU/mémoire |

Le verbe `delete` sur `resourcequotas`, `networkpolicies` et
`horizontalpodautoscalers` est indispensable : ces ressources sont **supprimées**
quand l'option correspondante est désactivée, ce qui est le cas par défaut.

---

## 8. Configuration

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `CONTROL_PLANE_ADDR` | `localhost:9090` | adresse gRPC du Control Plane |
| `CLUSTER_ID` | `local` | nom du cluster côté Control Plane |
| `CLUSTER_TOKEN` | — | jeton d'authentification |
| `INSECURE` | `true` | `true` = gRPC en clair — **à passer à `false` hors dev** |
| `KUBECONFIG` | *(auto)* | ignoré en mode in-cluster |
| `HEALTH_ADDR` | `:8081` | port des sondes |
| `STUCK_AFTER_SECONDS` | `300` | délai sans échange avant redémarrage |
| `PROMETHEUS_URL` | *(auto)* | source de métriques explicite |

### Valeurs Helm principales

```yaml
image:
  repository: maxwellfaraday/kybers-agent
  tag: dev

controlPlane:
  addr: ""              # requis — joignable DEPUIS le cluster
  clusterId: "local"
  insecure: true

auth:
  token: ""             # requis, ou existingSecret
  existingSecret: ""    # préférable en production

health:
  port: 8081
  stuckAfterSeconds: 300

metrics:
  prometheusUrl: ""     # vide = détection automatique

priorityClassName: ""   # ex. system-cluster-critical
```

---

## 9. Métriques

L'agent relève la consommation toutes les 30 secondes, depuis deux sources
possibles :

- **metrics-server** — priorité par défaut. Fournit le détail par nœud et par
  application.
- **Prometheus** — détecté automatiquement dans le cluster, ou configuré via
  `PROMETHEUS_URL`. Ne fournit que les **agrégats du cluster** : les requêtes
  PromQL varient trop d'une installation à l'autre pour un détail fiable.

Un Prometheus qui répond mais ne collecte pas les métriques de ressources
(node-exporter ou cAdvisor absents) est **écarté** plutôt que retenu : sinon
Kybers afficherait des zéros, laissant croire à un cluster inactif.

Si les deux sources existent, un menu dans le dashboard permet de choisir. Le
choix est persisté et réappliqué à chaque reconnexion de l'agent.

Sans aucune source, aucune métrique n'est envoyée et le dashboard l'indique
explicitement.

---

## 10. Limites connues

- **`INSECURE=true` par défaut.** Le transport TLS est prêt côté agent, mais le
  Control Plane ne présente pas encore de certificat et ne vérifie pas
  l'identité de l'agent. À traiter avant tout déploiement hors réseau de
  confiance.
- **Un seul agent par cluster**, sans haute disponibilité. Pendant son
  redémarrage, les ordres restent en file — rien n'est perdu, mais rien
  n'avance.
- **Prometheus partiel** : agrégats du cluster uniquement, pas de détail par
  nœud ni par application.
- **Pas de volumes persistants** : les applications déployées sont sans état.
- **cert-manager présumé** : l'issuer TLS est codé en dur (`letsencrypt-prod`).
  Sur un cluster avec un issuer nommé autrement, le certificat n'est pas émis et
  l'application reste joignable en HTTP.
- **CNI sans NetworkPolicy** : Flannel seul ignore silencieusement les
  NetworkPolicy créées. L'isolation est alors inopérante sans avertissement.

---

## 11. Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| `ImagePullBackOff` sur l'agent | architecture ou image absente | l'image publiée couvre amd64 et arm64 ; vérifier `image.repository` |
| « connexion perdue » en boucle | `controlPlane.addr` injoignable depuis le cluster | tester depuis un pod, vérifier NAT et pare-feu |
| « enregistrement refusé » | couple (cluster, jeton) inconnu | recréer le cluster dans le dashboard |
| Pod `0/1 Ready` mais pas de redémarrage | agent déconnecté — comportement normal | voir les logs pour la cause |
| Déploiements bloqués en `pending` | aucun agent connecté | `curl <control-plane>/healthz` |
| `resourcequotas is forbidden` | RBAC obsolète | mettre à jour le chart |
| Aucune métrique | ni metrics-server ni Prometheus exploitable | installer metrics-server, ou `--set metrics.prometheusUrl=…` |

---

## 12. Où lire le code

| Fichier | Contenu |
|---|---|
| `data-plane-agent/cmd/agent/main.go` | démarrage, configuration, sondes |
| `internal/client/client.go` | connexion gRPC, reconnexion, traitement des ordres |
| `internal/client/health.go` | logique des sondes de santé |
| `internal/k8s/reconciler.go` | traduction ordre → ressources Kubernetes |
| `internal/k8s/spec.go` | forme interne d'un déploiement, nommage |
| `internal/k8s/clusterinfo.go` | état du cluster remonté au dashboard |
| `internal/k8s/usage.go` | consommation via metrics-server |
| `internal/k8s/prometheus.go` | consommation via Prometheus |
| `charts/kybers-agent/` | chart Helm : RBAC, Deployment, sondes |
| `proto/kybers/v1/agent.proto` | contrat gRPC, partagé avec le Control Plane |
