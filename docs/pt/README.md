> Esta tradução segue o [original em inglês](../../README.md). O texto em inglês é o canónico; os comandos, as opções, os URL e os marcadores de posição não mudam.

<img src="../../brand/obsync-icon-256.png" alt="ícone do obsync: dois anéis entrelaçados" width="96" height="96">

# Self Hosted Private Sync

Sincronização em direto, autoalojada e cifrada de ponta a ponta para o
[Obsidian](https://obsidian.md). As suas notas são sincronizadas através de
um servidor executado por si. As notas, os anexos e os nomes dos ficheiros são
cifrados no seu dispositivo, e o servidor nunca recebe a chave. O plugin
funciona em todas as plataformas onde o Obsidian funciona, no computador e no
telemóvel. Sem subscrição e sem conta em mais lado nenhum.

**Alguma coisa não funciona? → [Resolução de problemas](https://snaraj.github.io/obsync/troubleshooting/)**

## Encontre o que precisa

Todas as páginas estão também no
[site da documentação](https://snaraj.github.io/obsync/). As páginas para as
quais as ligações apontam estão em inglês.

### Usar o obsync

| Quero… | Ir para |
| --- | --- |
| Escolher como os meus dispositivos chegam ao meu servidor | [Escolha a sua configuração](../setup.md) |
| Configurar tudo na minha rede de casa, com cada ecrã do telemóvel | [Mesma rede, passo a passo](../same-network.md) |
| Instalar o plugin | [Instalar o plugin](../community-plugin.md) |
| Configurar o meu primeiro dispositivo | [Arranque rápido](../quickstart.md) |
| Emparelhar um telemóvel ou outro computador | [Emparelhe o seu telemóvel](../quickstart.md#pair-your-phone) |
| Saber o que significam o ícone de estado e os comandos | [Utilização diária](../daily-use.md) e [Ler a barra de estado](../troubleshooting.md#reading-the-status-bar) |
| Recuperar uma versão anterior de uma nota | [Restaurar uma versão guardada](../daily-use.md#restore-a-retained-version) |
| Saber o que faz uma definição | [Definições](../settings.md) |
| Resolver uma cópia de conflito | [Conflitos](../conflicts.md) |
| Resolver um problema | [Resolução de problemas](../troubleshooting.md) |
| Voltar a entrar depois de perder um dispositivo | [Recuperação](../recovery.md) |
| Mudar o meu vault para outro servidor | [Mudar este vault para outro servidor](../recovery.md#moving-this-vault-to-a-different-server) |

### Executar um servidor

| Quero… | Ir para |
| --- | --- |
| Executar o meu servidor com Docker ou Compose | [Executar o servidor](../server.md) |
| Pô-lo atrás do meu próprio proxy (Caddy, nginx, Traefik, HAProxy) | [Já tem um terminador TLS](../server.md#already-have-a-tls-terminator-docker) |
| Executá-lo sem contentor, com systemd | [O binário estático](../server.md#without-a-container-the-static-binary) |
| Executar o meu servidor em Kubernetes | [Kubernetes](../kubernetes.md) e a [referência do chart](../../chart/README.md) |
| Chegar ao meu servidor fora de casa, pela minha própria VPN ou proxy | [Chegar a ele de fora da sua LAN](../server.md#reaching-it-from-outside-your-lan) |
| Usar a Cloudflare (opcional) | [Cloudflare](cloudflare.md) |
| Confiar no certificado do meu servidor em cada dispositivo | [Confiar na autoridade de certificação](../server.md#trust-the-certificate-authority-once-per-device) |
| Saber quanta memória e disco precisa | [Quanta memória precisa](../server.md#how-much-memory-it-needs) e [Armazenamento](../storage.md) |
| Fazer cópia de segurança do meu servidor | [Copiar os dois volumes](../server.md#back-up-the-two-volumes) |
| Atualizar o meu servidor | [Atualizar por digest](../server.md#upgrade-by-digest) |
| Ver os meus dispositivos e revogar um | [O painel](../dashboard.md) |
| Apagar o meu servidor e recomeçar | [Limpar um servidor](../purge.md) |
| Ver o que mudou em cada versão | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Confiança e privacidade

| Quero… | Ir para |
| --- | --- |
| Saber a que este plugin acede no meu dispositivo e na minha rede | [A que este plugin acede](#a-que-este-plugin-acede) |
| Perceber o que é cifrado e o que o servidor pode ver | [Modelo de ameaças](../threat-model.md) e [o modelo de ameaças do painel](../security/dashboard.md) |
| Comunicar um problema de segurança | [`SECURITY.md`](../../SECURITY.md) |

### Por dentro do projeto

Para quem contribui e revê: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[arquitetura](../architecture.md), [protocolo](../protocol.md),
[benchmarks](../benchmarks.md),
[sessões de validação em dispositivos](../validation-runs/) e
[todas as páginas](../README.md).

## Instalar

![As definições do plugin abrem com Get started: a linha Setup guide e o seu botão Open the guide, acima do campo Server URL](../assets/settings-get-started.png)

Instale o plugin em **Definições → Plugins não oficiais → Procurar**. Pesquise
**Self Hosted Private Sync** (id do plugin `obsync-private-sync`). Precisa do
Obsidian 1.13.0 ou posterior. As suas definições abrem com o guia de
configuração, a um toque de distância.

> [!IMPORTANT]
> - Sincroniza com um servidor executado por **si**: sem serviço alojado, sem conta em mais lado nenhum.
> - Faça primeiro uma cópia de segurança do seu vault; guarde a frase de recuperação de 24 palavras fora do dispositivo que a gerou.
> - Nunca o execute ao lado de outra sincronização (o Obsidian Sync, uma pasta na nuvem, outro plugin) no mesmo vault.
> - Software recente: leia a entrada do [`CHANGELOG.md`](../../CHANGELOG.md) correspondente à sua versão, atualize todos os dispositivos e saiba o que cada [sessão de validação](../validation-runs/) cobriu.

## Comece a sincronizar

O caminho completo mais curto é o Compose com o Caddy na sua própria rede, a
partir de uma cópia local deste repositório. Dá-lhe HTTPS em qualquer rede,
sem domínio e sem conta em lado nenhum.
[Mesma rede, passo a passo](../same-network.md) percorre-o com cada ecrã.
Substitua `vX.Y.Z` abaixo pelo lançamento que está a instalar: a etiqueta mais
recente na [página de Releases](https://github.com/snaraj/obsync/releases/latest).

**1. Verifique a imagem.** Depois execute exatamente o digest que a
verificação mostrou:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Inicie o servidor:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

O `OBSYNC_HOST` é o nome que os seus dispositivos vão escrever. Só tem de
resolver na sua própria rede. O `OBSYNC_BIND_ADDRESS` é o endereço em que as
portas 80 e 443 são publicadas: um endereço de escuta limita a interface de
destino, não a origem, por isso é a sua firewall que decide quem lhe chega. O
Compose recusa-se a arrancar enquanto não tiver escolhido.

**3. Leia o token de configuração.** No primeiro arranque, o servidor gera um
token de configuração e escreve-o no seu volume de diário, com modo 0600, e
nunca o regista. Cria a sua conta uma vez e continua a ser o início de sessão
de recuperação do painel. Guarde-o como a frase de recuperação:

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Configure cada dispositivo.** Confie no certificado do servidor, uma vez
([como](../server.md#trust-the-certificate-authority-once-per-device)).
Instale o plugin e depois siga o [Arranque rápido](../quickstart.md):
configure o primeiro dispositivo e depois emparelhe os outros.

Já tem HTTPS à frente, de um proxy ou de um túnel em que confia? Execute antes
o [servidor isolado](../server.md#already-have-a-tls-terminator-docker).

## A que este plugin acede

- **Ao seu servidor, e a mais nada.** Todos os pedidos vão para o **Server URL** que escreve; sem telemetria, sem terceiros.
- **A uma conta nesse servidor**, criada a partir do token de configuração; a sua conta do Obsidian não tem aqui qualquer papel.
- **Aos lançamentos no GitHub, através do Obsidian**, para instalar e atualizar; o Obsidian ignora os restantes ficheiros do lançamento.
- **À lista de ficheiros do seu vault**, para decidir o que sincronizar; as pastas ocultas (`.obsidian`, `.git`) e as que são ligações simbólicas ficam de fora.
- **À área de transferência, só para escrever**, a partir de **Copy code** e **Copy link** em **Pair a new device**; nunca é lida.
- **Ao seu navegador, quando pede o guia de configuração.** O guia do projeto abre-se lá; o plugin em si não envia nada.

O que o servidor pode e não pode ver: [`SECURITY.md`](../../SECURITY.md) e o [modelo de ameaças](../threat-model.md).

## Versões

O lançamento LATEST é a etiqueta mais recente na
[página de Releases](https://github.com/snaraj/obsync/releases/latest). É esse
que o Obsidian instala e para o qual atualiza. O `main` é o EDGE: trabalho já
integrado mas ainda não lançado, para quem compila a partir do código-fonte.
Não há canal beta nem etiquetas de pré-lançamento. A secção «Unreleased» do
registo de alterações descreve o que está no EDGE.

## Perguntas, erros e segurança

- **Uma pergunta, ou não tem a certeza de que é um erro:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Um erro:** [abra um issue](https://github.com/snaraj/obsync/issues/new/choose) com o relatório que a [Resolução de problemas](../troubleshooting.md#how-to-collect-a-report) descreve. Deixe de fora qualquer token, frase ou endereço que não publicaria.
- **Uma suspeita de vulnerabilidade:** em privado, através do [`SECURITY.md`](../../SECURITY.md), nunca num issue público.

## Licença

MIT. Ver [`LICENSE`](../../LICENSE).
