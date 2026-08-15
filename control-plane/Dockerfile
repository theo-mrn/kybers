# Build multi-étapes : le contexte de build doit être la RACINE du monorepo,
# car le module control-plane référence ../proto via une directive replace.
#   docker build -f control-plane/Dockerfile .
FROM golang:1.26-alpine AS build

WORKDIR /src

# Les go.mod/go.sum d'abord : cette couche est mise en cache tant que les
# dépendances ne changent pas.
COPY go.work ./
COPY proto/go.mod proto/go.sum* ./proto/
COPY control-plane/go.mod control-plane/go.sum ./control-plane/
COPY data-plane-agent/go.mod data-plane-agent/go.sum ./data-plane-agent/

COPY proto/ ./proto/
COPY control-plane/ ./control-plane/
COPY data-plane-agent/ ./data-plane-agent/

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" \
    -o /out/kybers-control-plane ./control-plane/cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 kybers
USER 10001
COPY --from=build /out/kybers-control-plane /usr/local/bin/kybers-control-plane
EXPOSE 8080 9090
ENTRYPOINT ["/usr/local/bin/kybers-control-plane"]
