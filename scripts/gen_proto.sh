#!/bin/sh
# Generate gRPC stubs for both sides from the single .proto.
# Run from the repo root, or point PROTO_ROOT at it.
set -e

PROTO_ROOT=${PROTO_ROOT:-$(dirname "$0")/..}
PROTO_FILE="$PROTO_ROOT/proto/anemoi/v1/agent.proto"

generate() {
    target=$1
    mkdir -p "$target"
    python -m grpc_tools.protoc \
        -I "$PROTO_ROOT/proto/anemoi/v1" \
        --python_out="$target" \
        --grpc_python_out="$target" \
        "$PROTO_FILE"

    # protoc emits "import agent_pb2", which only resolves when the generated
    # directory is on sys.path. Make it a package-relative import instead.
    sed -i 's/^import agent_pb2/from . import agent_pb2/' "$target/agent_pb2_grpc.py"
    printf '# Generated from proto/anemoi/v1/agent.proto. Do not edit.\n' > "$target/__init__.py"
}

generate "${1:-$PROTO_ROOT/panel/backend/app/grpc_gen}"
