> Esta tradução segue o [original em inglês](../../README.md). O texto em inglês é o canónico; os comandos, as opções, os URL e os marcadores de posição não mudam.

<img src="../../brand/obsync-icon-256.png" alt="ícone do obsync: dois anéis entrelaçados" width="96" height="96">

# Self Hosted Private Sync

Sincronização em direto, autoalojada e cifrada de ponta a ponta para o
[Obsidian](https://obsidian.md): um servidor em Rust sem dependências, com um
painel integrado, executado por si, mais este plugin. Ficheiros de qualquer
tamanho, todas as plataformas do Obsidian, sem subscrição, sem terceiros.

Instale-o em Definições → Plugins não oficiais → Procurar, com o nome **Self
Hosted Private Sync** (id do plugin `obsync-private-sync`), no Obsidian 1.13.0
ou posterior.

> [!IMPORTANT]
> - Sincroniza com um servidor executado por **si**: sem serviço alojado, sem
>   conta em mais lado nenhum.
> - Faça primeiro uma cópia de segurança do seu vault; guarde a frase de
>   recuperação de 24 palavras fora do dispositivo que a gerou.
> - Nunca o execute ao lado de outra sincronização (o Obsidian Sync, uma pasta
>   na nuvem, outro plugin) no mesmo vault.
> - Software recente: leia a entrada do [`CHANGELOG.md`](../../CHANGELOG.md)
>   correspondente à sua versão, atualize todos os dispositivos e saiba o que
>   cada [sessão de validação](../validation-runs/) cobriu.

## A que este plugin acede

- **Ao seu servidor, e a mais nada.** Todos os pedidos vão para o **Server
  URL** que escreve; sem telemetria, sem terceiros.
- **A uma conta nesse servidor**, criada a partir do token de configuração; a
  sua conta do Obsidian não tem aqui qualquer papel.
- **Aos lançamentos no GitHub, através do Obsidian**, para instalar e
  atualizar; o Obsidian ignora os restantes ficheiros do lançamento.
- **À lista de ficheiros do seu vault**, para decidir o que sincronizar; as
  pastas ocultas (`.obsidian`, `.git`) e as que são ligações simbólicas ficam
  de fora.
- **À área de transferência, só para escrever**, a partir de **Copy code** e
  **Copy link** em **Pair a new device**; nunca é lida.

O que o servidor pode e não pode ver: [`SECURITY.md`](../../SECURITY.md) e o
[modelo de ameaças](../threat-model.md).

## Comece a sincronizar

Cinco passos, do nada a dois dispositivos sincronizados. A `v1.0.6` é o
lançamento para o qual esta página foi escrita; use a etiqueta que está a
instalar.

### 1. Iniciar o servidor

Verifique a assinatura e depois execute exatamente o digest que a
verificação mostrou:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

O caminho simples é o Compose com o Caddy, a partir de uma cópia local deste
repositório: HTTPS em qualquer rede, sem domínio e sem conta em lado nenhum.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

O `OBSYNC_HOST` é o nome que os seus dispositivos vão escrever; só tem de
resolver na sua própria rede. O `OBSYNC_BIND_ADDRESS` é o endereço em que as
portas 80 e 443 são publicadas: um endereço de escuta limita a interface de
destino, não a origem, por isso é a sua firewall que decide quem lhe chega. O
Compose recusa-se a arrancar enquanto não tiver escolhido.

Já tem HTTPS à frente, de um proxy ou de um túnel em que confia? Execute antes
o servidor isolado: [Executar o servidor](../server.md).

### 2. Ler o token de configuração

No primeiro arranque, o servidor emite um token de configuração e escreve-o no
seu volume de diário, com modo 0600, e nunca o regista. Cria a sua conta uma
vez e continua a ser o início de sessão de recuperação do painel: guarde-o com
o mesmo cuidado que a frase de recuperação. Leia-o a partir do contentor:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Confiar no certificado, uma vez por dispositivo

O Caddy assina com uma autoridade que gerou no primeiro arranque; cada
dispositivo tem de confiar nela uma vez. Exporte o certificado de raiz e
instale-o em cada plataforma como mostra
[Executar o servidor](../server.md#trust-the-certificate-authority-once-per-device);
no iOS, confiar nele é um segundo interruptor depois de o instalar.

### 4. Configurar o primeiro dispositivo

1. Definições → Plugins não oficiais → Procurar → **Self Hosted Private
   Sync** → Instalar → Ativar.
2. Defina o **Server URL** para o seu servidor (`https://sync.example.org`,
   com a porta incluída quando não for a 443) e escolha depois **Whole vault**
   ou **Selected folders only**; mais tarde, a seleção só pode estreitar.

   ![O separador de definições do plugin: o campo Server URL com um nome de anfitrião de demonstração, a caixa dos cabeçalhos da edge e a linha Connection com os seus botões Check e Open dashboard](../assets/settings-server.png)

3. Cole o token de configuração em **First-time setup**, selecione **Set up**
   e escreva a frase de recuperação de 24 palavras.

   ![A secção This device do separador de definições: a linha Pairing com Pair this device e Pair a new device, a linha First-time setup com o campo Setup token e o botão Set up, e a linha Vault key](../assets/settings-setup.png)

### 5. Emparelhar o segundo dispositivo

1. Instale lá o plugin com o mesmo **Server URL**; no primeiro dispositivo,
   execute **Pair a new device** para obter um código válido durante dez
   minutos.

   ![A caixa de diálogo Pair a new device no primeiro dispositivo, com o código tapado, os botões Copy code e Copy link e a linha Waiting for the new device](../assets/pair-new-device.png)

2. No segundo dispositivo, abra **Pair this device**, cole o código e
   selecione **Pair**.
3. De volta ao primeiro dispositivo, aprove-o pelo nome. Edite uma nota em
   qualquer um deles; aparece no outro em segundos.

   ![O primeiro dispositivo a perguntar se deve aprovar o novo dispositivo pelo nome, com os botões Approve e Reject](../assets/pair-approve.png)

![Animação: o código de emparelhamento mostrado no primeiro dispositivo, colado no segundo, aprovado no primeiro, e a primeira nota a chegar ao segundo](../assets/pairing.gif)

A experimentar tudo num só computador? Num computador de secretária, o
`http://127.0.0.1:8080` chega ao servidor isolado; o Obsidian no iOS e no
Android recusa HTTP simples.

As capturas de ecrã de telemóvel ainda não estão neste repositório; são
tiradas nos dispositivos do próprio responsável pelo projeto e acrescentadas
quando uma sessão de validação as registar.

Cada passo por extenso: [Arranque rápido](../quickstart.md).

## Avançado: Cloudflare

A instalação de referência não tem nome de anfitrião público: um Cloudflare
Tunnel e uma rota privada chegam à rede do servidor, e o cliente Cloudflare
One de cada dispositivo leva lá o Server URL. Um nome de anfitrião público
atrás do Cloudflare Access, com um token de serviço em **Edge service-token
headers** e `OBSYNC_EDGE=cloudflare`, também funciona. Ambos, passo a passo:
[Cloudflare](cloudflare.md).

## Outras formas de chegar ao seu servidor

Escolha o que escolher, o plugin precisa de HTTPS com um certificado em que
todos os dispositivos confiem; o próprio servidor mantém-se em HTTP simples
por trás desse terminador.

- **Só LAN.** O caminho Compose acima, acessível apenas em casa; sem
  sincronização fora de casa.
- **WireGuard.** A sua própria VPN de volta a casa: o mais rápido e
  inteiramente seu; uma configuração de par em cada dispositivo.
- **Tailscale.** Uma malha WireGuard gerida: menos configuração; um terceiro
  coordena-a, nas condições do plano dele.
- **Um proxy inverso com TLS automático**, como o Caddy num nome público:
  acessível a partir da internet, e cabe-lhe a si atualizá-lo.
- **Cloudflare Tunnel.** Ver acima. Sem porta de entrada aberta; um fornecedor
  no caminho, com condições próprias.

Aquilo de que um dispositivo em mobilidade precisa (a rota, o nome, o
certificado, a firewall, o pedido de rede local do iOS):
[Chegar ao servidor a partir de fora da sua LAN](../server.md#reaching-it-from-outside-your-lan).

## Resolução de problemas

| Sintoma | Causa provável | Primeira coisa a tentar |
| --- | --- | --- |
| `obsync: offline` | O dispositivo não consegue chegar ao Server URL | Abra o URL num navegador nesse dispositivo; verifique a porta, o HTTPS e a rota |
| Um telemóvel não se liga enquanto um computador sincroniza | O certificado privado não é fidedigno no telemóvel | Instale o certificado de raiz; no iOS, ative-o também em «Certificate Trust Settings» |
| `401 stale_timestamp` | Um relógio está errado em mais de 300 segundos | Ative a hora automática, no dispositivo ou no servidor |
| `403 device_pending` | Ainda ninguém o aprovou | Aprove-o pelo nome no dispositivo a partir do qual emparelhou |
| Um ficheiro nunca chega | Está fora da seleção de pastas, ou acima do limite de tamanho de um telemóvel | Verifique **Sync folders on this device**; no telemóvel, execute **Show remote-only files** |

Todos os outros sintomas e códigos de erro, e como comunicar um:
[Resolução de problemas](../troubleshooting.md).

## Documentação

[Arranque rápido](../quickstart.md) · [Executar o servidor](../server.md) ·
[Cloudflare](cloudflare.md) · [Utilização diária](../daily-use.md) ·
[Definições](../settings.md) · [Resolução de problemas](../troubleshooting.md) ·
[Recuperação](../recovery.md) · [Registo de alterações](../../CHANGELOG.md)

Tudo o resto: [docs/README.md](../README.md).

## Perguntas, erros e segurança

- **Uma pergunta, ou não tem a certeza de que é um erro:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Um erro:** [abra um issue](https://github.com/snaraj/obsync/issues/new/choose)
  com o relatório que a [Resolução de problemas](../troubleshooting.md)
  descreve; sem token, sem frase de recuperação, sem endereços que não
  publicaria.
- **Uma suspeita de vulnerabilidade:** em privado, através do
  [`SECURITY.md`](../../SECURITY.md), nunca num issue público.

## Licença

MIT. Ver [`LICENSE`](../../LICENSE).
