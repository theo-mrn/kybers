#!/bin/sh
#
# Installe l'agent Kybers sur le cluster Kubernetes courant.
#
#   curl -sSL <control-plane>/install.sh | KYBERS_TOKEN=... KYBERS_CLUSTER=... sh
#
# Variables reconnues :
#   KYBERS_TOKEN      jeton du cluster (obligatoire)
#   KYBERS_CLUSTER    nom du cluster côté Control Plane (obligatoire)
#   KYBERS_ADDR       adresse gRPC du Control Plane, host:port
#   KYBERS_NAMESPACE  namespace d'installation (défaut : kybers-system)
#   KYBERS_INSECURE   true = gRPC en clair (défaut : false)
#   KYBERS_IMAGE      image de l'agent
#   PROMETHEUS_URL    source de métriques explicite

set -eu

# Valeurs injectées par le Control Plane au moment de servir ce script.
ADDR="${KYBERS_ADDR:-__ADDR__}"
IMAGE="${KYBERS_IMAGE:-__IMAGE__}"
CHART_URL="__CHART_URL__"
NAMESPACE="${KYBERS_NAMESPACE:-kybers-system}"
INSECURE="${KYBERS_INSECURE:-__INSECURE__}"
RELEASE="kybers-agent"

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

fail() {
  red "✗ $1"
  [ $# -gt 1 ] && printf '\n%s\n' "$2"
  exit 1
}

# --- Vérifications préalables -----------------------------------------------
# Mieux vaut échouer ici avec une cause claire qu'au milieu de l'installation.

[ -n "${KYBERS_TOKEN:-}" ] || fail "KYBERS_TOKEN manquant" \
  "Récupérez la commande complète depuis le dashboard Kybers, page Infrastructure."
[ -n "${KYBERS_CLUSTER:-}" ] || fail "KYBERS_CLUSTER manquant" \
  "Récupérez la commande complète depuis le dashboard Kybers, page Infrastructure."

command -v kubectl >/dev/null 2>&1 || fail "kubectl est introuvable" \
  "Installez kubectl : https://kubernetes.io/docs/tasks/tools/"
command -v helm >/dev/null 2>&1 || fail "helm est introuvable" \
  "Installez Helm 3 : https://helm.sh/docs/intro/install/"

kubectl cluster-info >/dev/null 2>&1 || fail "aucun cluster Kubernetes joignable" \
  "Vérifiez votre kubeconfig :  kubectl config current-context"

CONTEXT=$(kubectl config current-context 2>/dev/null || echo "?")

# Créer un namespace et des ClusterRole exige des droits d'administration.
if ! kubectl auth can-i create clusterrole >/dev/null 2>&1; then
  fail "droits insuffisants sur ce cluster" \
    "L'agent crée des namespaces et des ClusterRole : un accès administrateur est requis."
fi

printf '\n'
dim "Cluster Kubernetes : $CONTEXT"
dim "Control Plane      : $ADDR"
dim "Namespace          : $NAMESPACE"
printf '\n'

# --- Installation ------------------------------------------------------------

printf 'Installation de l'\''agent…\n'

INSECURE_FLAG="--set controlPlane.insecure=$INSECURE"
PROM_FLAG=""
[ -n "${PROMETHEUS_URL:-}" ] && PROM_FLAG="--set metrics.prometheusUrl=$PROMETHEUS_URL"

# shellcheck disable=SC2086
helm upgrade --install "$RELEASE" "$CHART_URL" \
  --namespace "$NAMESPACE" --create-namespace \
  --set image.repository="${IMAGE%%:*}" \
  --set image.tag="${IMAGE##*:}" \
  --set controlPlane.addr="$ADDR" \
  --set controlPlane.clusterId="$KYBERS_CLUSTER" \
  --set auth.token="$KYBERS_TOKEN" \
  $INSECURE_FLAG $PROM_FLAG \
  --wait --timeout 3m >/dev/null 2>&1 || {
    red "✗ l'installation a échoué"
    printf '\nDétail :\n'
    kubectl get pods -n "$NAMESPACE" 2>/dev/null || true
    kubectl logs -n "$NAMESPACE" -l app.kubernetes.io/name=kybers-agent --tail=20 2>/dev/null || true
    exit 1
  }

# --- Vérification ------------------------------------------------------------
# Une installation « réussie » dont l'agent ne se connecte pas serait un faux
# succès : on attend la connexion réelle.

printf 'Vérification de la connexion…\n'

i=0
while [ $i -lt 30 ]; do
  READY=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=kybers-agent \
    -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || echo "")
  [ "$READY" = "true" ] && break
  i=$((i + 1))
  sleep 2
done

printf '\n'
if [ "$READY" = "true" ]; then
  green "✓ Agent connecté au Control Plane"
  printf '\nLe cluster « %s » est prêt à recevoir des déploiements.\n' "$KYBERS_CLUSTER"
else
  red "✗ L'agent est installé mais ne s'est pas connecté"
  printf '\nCauses fréquentes :\n'
  printf '  · %s injoignable depuis ce cluster\n' "$ADDR"
  printf '  · jeton invalide ou cluster inconnu du Control Plane\n\n'
  printf 'Diagnostic :\n'
  printf '  kubectl logs -n %s -l app.kubernetes.io/name=kybers-agent --tail=30\n\n' "$NAMESPACE"
  kubectl get pods -n "$NAMESPACE" 2>/dev/null || true
  exit 1
fi

printf '\n'
dim "Désinstallation :  helm uninstall $RELEASE -n $NAMESPACE"
