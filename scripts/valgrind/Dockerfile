# Linux image for running the valgrind scripts on a host without valgrind
# (Windows). Built and driven by scripts/valgrind/launch.mjs.
FROM node:25-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends valgrind build-essential python3 cmake git \
    && rm -rf /var/lib/apt/lists/*
