# Caddy with the layer4 module, so that the agents' gRPC shares 443 with the
# web panel: a connection whose TLS hello names the agent endpoint is passed
# through to the backend untouched (mTLS stays end to end), everything else is
# the panel as before. One port open to the world instead of three.
ARG CADDY_VERSION=2.11.7
FROM caddy:${CADDY_VERSION}-builder-alpine AS build
RUN xcaddy build --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
