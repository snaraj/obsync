> Esta tradução acompanha o [original em inglês](../../README.md). O texto em inglês é o canônico; comandos, opções, URLs e marcadores de posição não mudam.

<img src="../../brand/obsync-icon-256.png" alt="ícone do obsync: dois anéis entrelaçados" width="96" height="96">

# Self Hosted Private Sync

Sincronização ao vivo, auto-hospedada e criptografada de ponta a ponta para o
[Obsidian](https://obsidian.md). Suas notas sincronizam por um servidor que
você mesmo roda. Notas, anexos e nomes de arquivos são criptografados no seu
dispositivo, e o servidor nunca recebe a chave. O plugin funciona em todas as
plataformas em que o Obsidian roda, no computador e no celular. Não há
assinatura nem conta em nenhum outro lugar.

**Algo não está funcionando? → [Solução de problemas](https://snaraj.github.io/obsync/troubleshooting/) (em inglês)**

## Encontre o que você precisa

Todas as páginas também estão no [site da documentação](https://snaraj.github.io/obsync/) (em inglês).

### Usar o obsync

| Eu quero… | Vá para |
| --- | --- |
| Escolher como meus dispositivos chegam ao meu servidor | [Escolha a sua configuração](../setup.md) |
| Configurar tudo na minha rede de casa, com cada tela do celular | [Mesma rede, passo a passo](../same-network.md) |
| Instalar o plugin | [Instalar o plugin](../community-plugin.md) |
| Configurar meu primeiro dispositivo | [Início rápido](../quickstart.md) |
| Parear um celular ou outro computador | [Parear o seu celular](../quickstart.md#pair-your-phone) |
| Saber o que o ícone de status e os comandos significam | [Uso diário](../daily-use.md) e [Como ler a barra de status](../troubleshooting.md#reading-the-status-bar) |
| Recuperar uma versão anterior de uma nota | [Restaurar uma versão guardada](../daily-use.md#restore-a-retained-version) |
| Saber o que uma configuração faz | [Configurações](../settings.md) |
| Lidar com uma cópia de conflito | [Conflitos](../conflicts.md) |
| Resolver um problema | [Solução de problemas](../troubleshooting.md) |
| Voltar a entrar depois de perder um dispositivo | [Recuperação](../recovery.md) |
| Levar meu cofre para outro servidor | [Mudar este cofre para outro servidor](../recovery.md#moving-this-vault-to-a-different-server) |

### Rodar um servidor

| Eu quero… | Vá para |
| --- | --- |
| Rodar meu servidor com Docker ou Compose | [Rodar o servidor](../server.md) |
| Colocá-lo atrás do meu próprio proxy (Caddy, nginx, Traefik, HAProxy) | [Já tem um terminador TLS](../server.md#already-have-a-tls-terminator-docker) |
| Rodá-lo sem contêiner, com o systemd | [O binário estático](../server.md#without-a-container-the-static-binary) |
| Rodar meu servidor no Kubernetes | [Kubernetes](../kubernetes.md) e a [referência do chart](../../chart/README.md) |
| Alcançar meu servidor fora de casa, pela minha própria VPN ou proxy | [Alcançá-lo de fora da sua LAN](../server.md#reaching-it-from-outside-your-lan) |
| Usar a Cloudflare (opcional) | [Cloudflare](cloudflare.md) |
| Confiar no certificado do meu servidor em cada dispositivo | [Confiar na autoridade certificadora](../server.md#trust-the-certificate-authority-once-per-device) |
| Saber de quanta memória e de quanto disco ele precisa | [De quanta memória ele precisa](../server.md#how-much-memory-it-needs) e [Armazenamento](../storage.md) |
| Fazer backup do meu servidor | [Faça backup dos dois volumes](../server.md#back-up-the-two-volumes) |
| Atualizar meu servidor | [Atualizar por digest](../server.md#upgrade-by-digest) |
| Ver meus dispositivos e revogar um deles | [O painel](../dashboard.md) |
| Apagar meu servidor e começar de novo | [Limpar um servidor](../purge.md) |
| Ver o que mudou em cada versão | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Confiança e privacidade

| Eu quero… | Vá para |
| --- | --- |
| Saber o que este plugin toca no meu dispositivo e na minha rede | [O que este plugin acessa](#o-que-este-plugin-acessa) |
| Entender o que é criptografado e o que o servidor pode ver | [Modelo de ameaças](../threat-model.md) e [o modelo de ameaças do painel](../security/dashboard.md) |
| Relatar um problema de segurança | [`SECURITY.md`](../../SECURITY.md) |

### Por dentro do projeto

Para quem contribui e revisa: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[arquitetura](../architecture.md), [protocolo](../protocol.md),
[benchmarks](../benchmarks.md), [sessões de validação em dispositivos](../validation-runs/)
e [todas as páginas](../README.md).

## Instalar

![As configurações do plugin abrindo com Get started: a linha Setup guide e o seu botão Open the guide, acima do campo Server URL](../assets/settings-get-started.png)

Instale o plugin em **Configurações → Plugins não oficiais → Procurar**.
Busque **Self Hosted Private Sync** (id do plugin `obsync-private-sync`). Ele
precisa do Obsidian 1.13.0 ou mais novo. As configurações dele abrem com o
guia de configuração, a um clique de distância.

> [!IMPORTANT]
> - Ele sincroniza com um servidor que **você** roda: sem serviço hospedado, sem conta em outro lugar.
> - Faça backup do seu cofre antes; guarde a frase de recuperação de 24 palavras fora do dispositivo que a gerou.
> - Nunca o rode junto de outra sincronização (Obsidian Sync, uma pasta na nuvem, outro plugin) no mesmo cofre.
> - Software jovem: leia a entrada do [`CHANGELOG.md`](../../CHANGELOG.md) da sua versão, atualize todos os dispositivos e saiba o que cada [sessão de validação](../validation-runs/) cobriu.

## Começar a sincronizar

O caminho completo mais curto é o Compose com o Caddy na sua própria rede, a
partir de um checkout deste repositório. Ele dá HTTPS em qualquer rede, sem
domínio e sem conta em lugar nenhum. [Mesma rede, passo a passo](../same-network.md)
percorre esse caminho com cada tela. Troque `vX.Y.Z` abaixo pela versão que
você está instalando: a tag mais recente na
[página de Releases](https://github.com/snaraj/obsync/releases/latest).

**1. Verifique a imagem.** Depois rode exatamente o digest que a verificação imprimiu:

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

`OBSYNC_HOST` é o nome que os seus dispositivos vão digitar. Ele só precisa
resolver na sua própria rede. `OBSYNC_BIND_ADDRESS` é o endereço em que as
portas 80 e 443 são publicadas: um endereço de bind limita a interface de
destino, não a de origem, então é o seu firewall que decide quem o alcança. O
Compose se recusa a iniciar enquanto você não escolher.

**3. Leia o token de configuração.** Na primeira inicialização, o servidor
emite um token de configuração e o grava no seu volume de journal, com modo
0600 e nunca registrado em log. Ele cria a sua conta uma vez e continua sendo o
login de recuperação do painel. Guarde-o com o mesmo cuidado que a frase de
recuperação:

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Configure cada dispositivo.** Confie no certificado do servidor uma vez
([como fazer](../server.md#trust-the-certificate-authority-once-per-device)).
Instale o plugin e siga o [Início rápido](../quickstart.md): configure o
primeiro dispositivo e depois pareie os outros.

Já tem HTTPS na frente, vindo de um proxy ou de um túnel em que você confia?
Rode o [servidor puro](../server.md#already-have-a-tls-terminator-docker) no
lugar deste caminho.

## O que este plugin acessa

- **O seu servidor, e mais nada.** Toda requisição vai para a **Server URL** que você digita; sem telemetria, sem terceiros.
- **Uma conta nesse servidor**, criada a partir do token de configuração; a sua conta do Obsidian não tem papel nenhum.
- **Os GitHub Releases, pelo Obsidian**, para instalar e atualizar; o Obsidian ignora os arquivos extras do release.
- **A lista de arquivos do seu cofre**, para decidir o que sincronizar; pastas ocultas (`.obsidian`, `.git`) e pastas que são links simbólicos ficam de fora.
- **A área de transferência, apenas escrita** por **Copy code** e **Copy link** em **Pair a new device**, nunca lida.
- **O seu navegador, quando você pede o guia de configuração.** O guia do projeto abre nele; o próprio plugin não envia nada.

O que o servidor pode e o que não pode ver: [`SECURITY.md`](../../SECURITY.md) e o [modelo de ameaças](../threat-model.md).

## Versões

A versão LATEST é a tag mais recente na
[página de Releases](https://github.com/snaraj/obsync/releases/latest). É ela
que o Obsidian instala e para a qual ele atualiza. `main` é a EDGE: trabalho já
mesclado, mas ainda não lançado, para quem compila a partir do código-fonte.
Não há canal beta nem tag de pré-lançamento. A seção Unreleased do changelog é
o registro da EDGE.

## Dúvidas, bugs e segurança

- **Uma dúvida, ou algo que você não tem certeza se é um bug:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Um bug:** [abra uma issue](https://github.com/snaraj/obsync/issues/new/choose) com o relatório que a [Solução de problemas](../troubleshooting.md#how-to-collect-a-report) descreve. Deixe de fora qualquer token, frase ou endereço que você não publicaria.
- **Uma suspeita de vulnerabilidade:** em caráter privado, pelo [`SECURITY.md`](../../SECURITY.md), nunca como uma issue pública.

## Licença

MIT. Veja [`LICENSE`](../../LICENSE).
