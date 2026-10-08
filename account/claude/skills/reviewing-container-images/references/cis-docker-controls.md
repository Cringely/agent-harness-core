# CIS Docker Benchmark v1.6.0 controls (docker-bench-security numbering)

Source: docker/docker-bench-security, `tests/1_*.sh` to `tests/7_*.sh` at commit
`154869da6418089decf7e1ab0cfca0e1cdfc5c49` (master, committed 2026-06-04), script version 1.6.0.
docker-bench-security is Apache-2.0. The CIS Docker Benchmark is the property of the Center for Internet
Security. The numbers and titles below are what docker-bench implements for CIS v1.6.0, read from the
`id` and `desc` variables of each check function. They are not copied from the CIS PDF.

## Citation rule

Cite a CIS Docker number only if it appears in this file, with the title shown here. If a control you
want is missing, describe it in words and cite no number. Do not cite hadolint, Dockerfile linter, or
other benchmark rule numbers unless you read the rule page in this session and name it.

## How to read a line

`number | title | tag | scope [| not tested]`

- Tag is the label docker-bench prints: Automated, Manual, or Scored. Section 2 uses Scored where the
  other sections use Automated. The scripts carry no CIS Level 1 or Level 2 field, so no levels are given.
- Scope says what evidence can decide the control:
  - I: the image itself or its Dockerfile (`docker image inspect`, `docker history`, SBOM, file listing)
  - R: the run configuration (compose or stack file, `docker run` flags, `docker inspect` of a container)
  - H: the host or daemon (needs host access, usually root)
- `not tested`: docker-bench prints NOTE or INFO for this control and runs no test. A clean docker-bench
  run says nothing about it. Decide it yourself from the evidence named by its scope.

Known source drift: the README example says `check_2_2` is the logging-level check. In the test
script at this commit, 2.2 is inter-container traffic and 2.3 is the logging level. Trust the scripts.
2.18 prints "(Deprecated)" on Docker versions newer than 19.03.

### 1 Host Configuration

### 1.1 Linux Hosts Specific Configuration

- 1.1.1 | Ensure a separate partition for containers has been created | Automated | H
- 1.1.2 | Ensure only trusted users are allowed to control Docker daemon | Automated | H
- 1.1.3 | Ensure auditing is configured for the Docker daemon | Automated | H
- 1.1.4 | Ensure auditing is configured for Docker files and directories -/run/containerd | Automated | H
- 1.1.5 | Ensure auditing is configured for Docker files and directories - /var/lib/docker | Automated | H
- 1.1.6 | Ensure auditing is configured for Docker files and directories - /etc/docker | Automated | H
- 1.1.7 | Ensure auditing is configured for Docker files and directories - docker.service | Automated | H
- 1.1.8 | Ensure auditing is configured for Docker files and directories - containerd.sock | Automated | H
- 1.1.9 | Ensure auditing is configured for Docker files and directories - docker.socket | Automated | H
- 1.1.10 | Ensure auditing is configured for Docker files and directories - /etc/default/docker | Automated | H
- 1.1.11 | Ensure auditing is configured for Dockerfiles and directories - /etc/docker/daemon.json | Automated | H
- 1.1.12 | Ensure auditing is configured for Dockerfiles and directories - /etc/containerd/config.toml | Automated | H
- 1.1.13 | Ensure auditing is configured for Docker files and directories - /etc/sysconfig/docker | Automated | H
- 1.1.14 | Ensure auditing is configured for Docker files and directories - /usr/bin/containerd | Automated | H
- 1.1.15 | Ensure auditing is configured for Docker files and directories - /usr/bin/containerd-shim | Automated | H
- 1.1.16 | Ensure auditing is configured for Docker files and directories - /usr/bin/containerd-shim-runc-v1 | Automated | H
- 1.1.17 | Ensure auditing is configured for Docker files and directories - /usr/bin/containerd-shim-runc-v2 | Automated | H
- 1.1.18 | Ensure auditing is configured for Docker files and directories - /usr/bin/runc | Automated | H

### 1.2 General Configuration

- 1.2.1 | Ensure the container host has been Hardened | Manual | H | not tested
- 1.2.2 | Ensure that the version of Docker is up to date | Manual | H

### 2 Docker daemon configuration

- 2.1 | Run the Docker daemon as a non-root user, if possible | Manual | H | not tested
- 2.2 | Ensure network traffic is restricted between containers on the default bridge | Scored | H
- 2.3 | Ensure the logging level is set to 'info' | Scored | H
- 2.4 | Ensure Docker is allowed to make changes to iptables | Scored | H
- 2.5 | Ensure insecure registries are not used | Scored | H
- 2.6 | Ensure aufs storage driver is not used | Scored | H
- 2.7 | Ensure TLS authentication for Docker daemon is configured | Scored | H
- 2.8 | Ensure the default ulimit is configured appropriately | Manual | H
- 2.9 | Enable user namespace support | Scored | H
- 2.10 | Ensure the default cgroup usage has been confirmed | Scored | H
- 2.11 | Ensure base device size is not changed until needed | Scored | H
- 2.12 | Ensure that authorization for Docker client commands is enabled | Scored | H
- 2.13 | Ensure centralized and remote logging is configured | Scored | H
- 2.14 | Ensure containers are restricted from acquiring new privileges | Scored | H
- 2.15 | Ensure live restore is enabled | Scored | H
- 2.16 | Ensure Userland Proxy is Disabled | Scored | H
- 2.17 | Ensure that a daemon-wide custom seccomp profile is applied if appropriate | Manual | H
- 2.18 | Ensure that experimental features are not implemented in production | Scored | H

### 3 Docker daemon configuration files

- 3.1 | Ensure that the docker.service file ownership is set to root:root | Automated | H
- 3.2 | Ensure that docker.service file permissions are appropriately set | Automated | H
- 3.3 | Ensure that docker.socket file ownership is set to root:root | Automated | H
- 3.4 | Ensure that docker.socket file permissions are set to 644 or more restrictive | Automated | H
- 3.5 | Ensure that the /etc/docker directory ownership is set to root:root | Automated | H
- 3.6 | Ensure that /etc/docker directory permissions are set to 755 or more restrictively | Automated | H
- 3.7 | Ensure that registry certificate file ownership is set to root:root | Automated | H
- 3.8 | Ensure that registry certificate file permissions are set to 444 or more restrictively | Automated | H
- 3.9 | Ensure that TLS CA certificate file ownership is set to root:root | Automated | H
- 3.10 | Ensure that TLS CA certificate file permissions are set to 444 or more restrictively | Automated | H
- 3.11 | Ensure that Docker server certificate file ownership is set to root:root | Automated | H
- 3.12 | Ensure that the Docker server certificate file permissions are set to 444 or more restrictively | Automated | H
- 3.13 | Ensure that the Docker server certificate key file ownership is set to root:root | Automated | H
- 3.14 | Ensure that the Docker server certificate key file permissions are set to 400 | Automated | H
- 3.15 | Ensure that the Docker socket file ownership is set to root:docker | Automated | H
- 3.16 | Ensure that the Docker socket file permissions are set to 660 or more restrictively | Automated | H
- 3.17 | Ensure that the daemon.json file ownership is set to root:root | Automated | H
- 3.18 | Ensure that daemon.json file permissions are set to 644 or more restrictive | Automated | H
- 3.19 | Ensure that the /etc/default/docker file ownership is set to root:root | Automated | H
- 3.20 | Ensure that the /etc/default/docker file permissions are set to 644 or more restrictively | Automated | H
- 3.21 | Ensure that the /etc/sysconfig/docker file permissions are set to 644 or more restrictively | Automated | H
- 3.22 | Ensure that the /etc/sysconfig/docker file ownership is set to root:root | Automated | H
- 3.23 | Ensure that the Containerd socket file ownership is set to root:root | Automated | H
- 3.24 | Ensure that the Containerd socket file permissions are set to 660 or more restrictively | Automated | H

### 4 Container Images and Build File

- 4.1 | Ensure that a user for the container has been created | Automated | I+R
- 4.2 | Ensure that containers use only trusted base images | Manual | I | not tested
- 4.3 | Ensure that unnecessary packages are not installed in the container | Manual | I | not tested
- 4.4 | Ensure images are scanned and rebuilt to include security patches | Manual | I | not tested
- 4.5 | Ensure Content trust for Docker is Enabled | Automated | H
- 4.6 | Ensure that HEALTHCHECK instructions have been added to container images | Automated | I
- 4.7 | Ensure update instructions are not used alone in the Dockerfile | Manual | I
- 4.8 | Ensure setuid and setgid permissions are removed | Manual | I | not tested
- 4.9 | Ensure that COPY is used instead of ADD in Dockerfiles | Manual | I
- 4.10 | Ensure secrets are not stored in Dockerfiles | Manual | I | not tested
- 4.11 | Ensure only verified packages are installed | Manual | I | not tested
- 4.12 | Ensure all signed artifacts are validated | Manual | I | not tested

### 5 Container Runtime

- 5.1 | Ensure swarm mode is not Enabled, if not needed | Automated | H
- 5.2 | Ensure that, if applicable, an AppArmor Profile is enabled | Automated | R+H
- 5.3 | Ensure that, if applicable, SELinux security options are set | Automated | R+H
- 5.4 | Ensure that Linux kernel capabilities are restricted within containers | Automated | R
- 5.5 | Ensure that privileged containers are not used | Automated | R
- 5.6 | Ensure sensitive host system directories are not mounted on containers | Automated | R
- 5.7 | Ensure sshd is not run within containers | Automated | I+R
- 5.8 | Ensure privileged ports are not mapped within containers | Automated | R
- 5.9 | Ensure that only needed ports are open on the container | Manual | I+R
- 5.10 | Ensure that the host's network namespace is not shared | Automated | R
- 5.11 | Ensure that the memory usage for containers is limited | Automated | R
- 5.12 | Ensure that CPU priority is set appropriately on containers | Automated | R
- 5.13 | Ensure that the container's root filesystem is mounted as read only | Automated | R
- 5.14 | Ensure that incoming container traffic is bound to a specific host interface | Automated | R
- 5.15 | Ensure that the 'on-failure' container restart policy is set to '5' | Automated | R
- 5.16 | Ensure that the host's process namespace is not shared | Automated | R
- 5.17 | Ensure that the host's IPC namespace is not shared | Automated | R
- 5.18 | Ensure that host devices are not directly exposed to containers | Manual | R
- 5.19 | Ensure that the default ulimit is overwritten at runtime if needed | Manual | R
- 5.20 | Ensure mount propagation mode is not set to shared | Automated | R
- 5.21 | Ensure that the host's UTS namespace is not shared | Automated | R
- 5.22 | Ensure the default seccomp profile is not Disabled | Automated | R
- 5.23 | Ensure that docker exec commands are not used with the privileged option | Automated | H | not tested
- 5.24 | Ensure that docker exec commands are not used with the user=root option | Manual | H | not tested
- 5.25 | Ensure that cgroup usage is confirmed | Automated | R
- 5.26 | Ensure that the container is restricted from acquiring additional privileges | Automated | R
- 5.27 | Ensure that container health is checked at runtime | Automated | I+R
- 5.28 | Ensure that Docker commands always make use of the latest version of their image | Manual | H | not tested
- 5.29 | Ensure that the PIDs cgroup limit is used | Automated | R
- 5.30 | Ensure that Docker's default bridge 'docker0' is not used | Manual | R+H
- 5.31 | Ensure that the host's user namespaces are not shared | Automated | R
- 5.32 | Ensure that the Docker socket is not mounted inside any containers | Automated | R

### 6 Docker Security Operations

- 6.1 | Ensure that image sprawl is avoided | Manual | H | not tested
- 6.2 | Ensure that container sprawl is avoided | Manual | H | not tested

### 7 Docker Swarm Configuration

Controls 7.1 to 7.9 exist in `tests/7_docker_swarm_configuration.sh` (manager count, swarm service
binding, overlay encryption, swarm secrets, auto-lock, certificate rotation, plane separation). Read
that file at the commit above if the deployment uses swarm mode. Otherwise out of scope.

## Running docker-bench on a host

Run only with the host owner's written sign-off. It needs root, or a container started with
`--net host --pid host --userns host`, the Docker socket, and read access to `/etc`, `/var/lib` and the
container runtime binaries (README at the same commit). Pin the clone to a commit you record:

```sh
git clone https://github.com/docker/docker-bench-security.git
cd docker-bench-security && git checkout <sha-you-record>
sudo sh docker-bench-security.sh -l /tmp/docker-bench.log
sudo sh docker-bench-security.sh -c container_images,container_runtime   # sections 4 and 5 only
```

Output lands in `docker-bench-security.log` and `docker-bench-security.log.json` unless `-l` is given.
