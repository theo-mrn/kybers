.PHONY: help proto build test up down agent dashboard lint clean

help: ## Affiche cette aide
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

proto: ## Régénère le code Go depuis les .proto (nécessite buf)
	buf generate

build: ## Compile les binaires Go
	go build -o bin/kybers-control-plane ./control-plane/cmd/server
	go build -o bin/kybers-agent ./data-plane-agent/cmd/agent

test: ## Lance les tests Go
	go test ./control-plane/... ./data-plane-agent/... ./proto/...

up: ## Démarre Control Plane + PostgreSQL
	docker compose up -d --build

down: ## Arrête la stack (garde les données)
	docker compose down

agent: build ## Lance l'agent en local contre le cluster courant
	CONTROL_PLANE_ADDR=localhost:9090 CLUSTER_ID=local \
	CLUSTER_TOKEN=dev-cluster-token INSECURE=true ./bin/kybers-agent

dashboard: ## Lance le dashboard en développement
	cd dashboard && npm run dev

lint: ## Vérifie le chart Helm et le formatage Go
	gofmt -l ./control-plane ./data-plane-agent
	go vet ./control-plane/... ./data-plane-agent/...
	helm lint data-plane-agent/charts/kybers-agent

clean: ## Supprime les binaires et les namespaces de test
	rm -rf bin
	kubectl delete ns -l app.kubernetes.io/managed-by=kybers --ignore-not-found
