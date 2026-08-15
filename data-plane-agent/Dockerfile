# Contexte de build = racine du monorepo :
#   docker build -f data-plane-agent/Dockerfile -t kybers/agent:dev .
FROM golang:1.26-alpine AS build

WORKDIR /src

COPY go.work ./
COPY proto/go.mod proto/go.sum* ./proto/
COPY control-plane/go.mod control-plane/go.sum ./control-plane/
COPY data-plane-agent/go.mod data-plane-agent/go.sum ./data-plane-agent/

COPY proto/ ./proto/
COPY control-plane/ ./control-plane/
COPY data-plane-agent/ ./data-plane-agent/

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" \
    -o /out/kybers-agent ./data-plane-agent/cmd/agent

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 kybers
USER 10001
COPY --from=build /out/kybers-agent /usr/local/bin/kybers-agent
# Aucun EXPOSE : l'agent n'accepte aucune connexion entrante.
ENTRYPOINT ["/usr/local/bin/kybers-agent"]
