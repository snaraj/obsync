> Esta tradução segue o [original em inglês](../../README.md). O texto em inglês é o canónico; os comandos, as opções, os URL e os marcadores de posição não mudam.

# Self Hosted Private Sync

Sincronização em direto, autoalojada e cifrada de ponta a ponta para o
[Obsidian](https://obsidian.md): um servidor em Rust sem dependências, com um
painel integrado, executado por si, mais este plugin. Ficheiros de qualquer
tamanho, todas as plataformas do Obsidian, sem subscrição, sem terceiros.

Instale-o em Definições → Plugins não oficiais → Procurar, com o nome **Self
Hosted Private Sync** (id do plugin `obsync-private-sync`), no Obsidian 1.13.0
ou posterior.

> [!IMPORTANT]
> Este plugin sincroniza com um servidor **seu**, executado por si. Não existe
> nenhum serviço alojado nem conta com ninguém a não ser consigo próprio: sem
> o seu próprio `obsyncd` acessível por HTTPS, o plugin não tem nada com que
> sincronizar.

> [!IMPORTANT]
> Faça uma cópia de segurança do seu vault antes da primeira sincronização e
> guarde a frase de recuperação de 24 palavras num sítio que não seja o
> dispositivo que a gerou. O servidor só armazena texto cifrado e não lhe pode
> recuperar um vault.

> [!IMPORTANT]
> Não execute este plugin ao lado de outra solução de sincronização no mesmo
> vault — o Obsidian Sync, uma pasta na nuvem que sincroniza ficheiros ou
> outro plugin de sincronização. Dois processos a escrever no mesmo vault
> produzem conflitos que nenhum deles consegue reconciliar.

## Antes de confiar nele

Isto é software recente que sincroniza a única cópia das suas notas.

- **O [`CHANGELOG.md`](../../CHANGELOG.md) é a lista mantida do que se sabe.**
  Leia a entrada da versão em que está e as entradas acima dela. As páginas de
  cada lançamento mantêm as notas com que foram publicadas; as descobertas
  posteriores são acrescentadas aqui.
- **Atualize todos os dispositivos que sincronizam um vault.** Um dispositivo
  deixado numa versão mais antiga ainda pode agir segundo o comportamento
  antigo e afetar os outros.
- **O que foi exercitado em hardware** está registado por sessão em
  [`docs/validation-runs/`](../validation-runs/), incluindo o que cada sessão
  não cobriu. Uma plataforma que nenhuma sessão nomeia não está provada.
- **Uma série de avisos «merged concurrent edits»** em dois dispositivos a
  editar a mesma nota: feche o Obsidian num deles para que o outro possa
  concluir o trabalho pendente, atualize ambos e depois retome.

## A que este plugin acede

Curto e completo, para que possa decidir antes de instalar.

- **Um único destino de rede: o seu próprio servidor.** Todos os pedidos vão
  para o **Server URL** que escreve nas definições do plugin, e para mais
  nada. Não há telemetria, nem análise de utilização, nem relatórios de
  falhas, nem publicidade, nem qualquer serviço de terceiros no caminho da
  sincronização. O plugin também nunca transfere nem executa código a partir
  desse servidor.
- **Uma conta nesse servidor, criada por si.** O primeiro dispositivo usa o
  token de configuração que o seu servidor escreveu no primeiro arranque;
  todos os outros dispositivos são emparelhados a partir de um dispositivo que
  já sincroniza. A sua conta do Obsidian não tem aqui qualquer papel.
- **O Obsidian e o GitHub, apenas para instalar e atualizar.** O próprio
  Obsidian transfere `main.js`, `manifest.json` e `styles.css` a partir dos
  lançamentos no GitHub deste repositório. Cada lançamento traz também um ZIP
  do plugin e um manifesto de lançamento para quem instala o servidor; o
  Obsidian ignora ambos.
- **A sua edge, só se tiver configurado uma.** Os cabeçalhos que cola em
  **Edge service-token headers** seguem em cada pedido para o Server URL
  acima, porque o proxy que precisa deles está no caminho até ao seu servidor.
- **A lista de ficheiros do seu vault.** O plugin lista todos os ficheiros do
  vault para decidir o que está abrangido, lê os ficheiros dentro da sua
  seleção de pastas e escreve o que os outros dispositivos alteraram. As
  pastas ocultas (`.obsidian`, `.git`) e as pastas que são ligações simbólicas
  são ignoradas.
- **A área de transferência, escrita e nunca lida.** Só os botões
  **Copy code** e **Copy link** em **Pair a new device** escrevem nela. Nada
  no plugin lê a área de transferência.
- **O seu navegador, quando pede o painel.** **Open dashboard** abre uma
  hiperligação de início de sessão no seu navegador, e apenas quando essa
  hiperligação está na origem do seu próprio servidor.
- **O armazenamento de segredos do Obsidian.** A chave do vault, o segredo do
  dispositivo e quaisquer valores de cabeçalhos da edge vivem lá, nunca nos
  dados simples do plugin.

O que o servidor pode e não pode ver está em
[`SECURITY.md`](../../SECURITY.md) e
[`docs/threat-model.md`](../threat-model.md).

## Sincronizar em cinco passos

O caminho em que este lançamento foi validado, de um vault vazio a dois
dispositivos sincronizados. Todos os cinco pressupõem que o seu próprio
servidor já está a correr, que é a secção abaixo; cada passo está escrito por
extenso no arranque rápido.

1. **Instalar a partir dos Plugins não oficiais.** Em Definições → Plugins não
   oficiais → Procurar, pesquise **Self Hosted Private Sync** e selecione
   Instalar e depois Ativar — da mesma maneira que chega qualquer outro plugin
   do Obsidian, em todas as plataformas.

   ![O explorador de Plugins não oficiais do Obsidian a mostrar o Self Hosted Private Sync com o seu botão Instalar](../captures/01-install-from-directory.png)

2. **Apontá-lo para o seu servidor e configurá-lo.** Abra o separador de
   definições do plugin, defina o **Server URL** para o seu próprio servidor,
   escolha que pastas este dispositivo sincroniza e depois cole o seu token de
   configuração em **First-time setup**.

   ![O separador de definições do plugin, deslocado até à seleção de pastas, à linha Pairing e ao campo do token em First-time setup](../captures/02-first-time-setup.png)

3. **Guardar a frase de recuperação.** A configuração gera a chave do vault
   neste dispositivo e mostra uma vez uma frase de 24 palavras: escreva-a e
   guarde-a num sítio que não seja este dispositivo, porque o servidor guarda
   apenas texto cifrado e não lhe pode recuperar um vault.

   ![A caixa de diálogo da frase de recuperação, mostrada depois da configuração inicial, com as palavras tapadas](../captures/03-recovery-phrase.png)

4. **Emparelhar um segundo dispositivo com um código de utilização única.**
   Execute **Pair a new device** no primeiro dispositivo, introduza no segundo
   o código que ele mostra, dentro de dez minutos, e aprove o dispositivo pelo
   nome — a chave do vault viaja cifrada sob um segredo de emparelhamento que
   o servidor nunca vê.

   ![A caixa de diálogo Pair a new device no primeiro dispositivo, com o código de utilização única tapado](../captures/04-pair-a-new-device.png)

5. **Editar num dos dispositivos e ver a alteração chegar.** Escreva numa nota
   num dispositivo e ela aparece no outro em segundos, nos dois sentidos, com
   a barra de estado a mostrar o que a sincronização está a fazer.

   ![A nota descartável com as edições de ambos os dispositivos e a barra de estado da sincronização visível](../captures/05-sync-both-ways.png)

A lista de dispositivos do painel e o seu botão de revogação estão descritos
em [Ver os seus dispositivos](../daily-use.md#see-your-devices) e não foram
exercitados na sessão de dispositivos da 1.0.0 registada em
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Comece a sincronizar

O caminho correto mais curto: uma máquina sua executa o servidor, todos os
dispositivos chegam a ela por HTTPS e cada dispositivo é emparelhado uma vez.
Iniciar sessão no Obsidian não autoriza nada aqui; a única conta é a que tem
no seu servidor.

### 1. Iniciar o servidor

Duas maneiras de o iniciar. Ambas executam exatamente os bytes que quem
publica assinou: verifique a assinatura, leia o digest a partir da saída
verificada e execute esse digest. `v1.0.6` é o lançamento para o qual esta
página foi escrita; use a etiqueta do lançamento que está a instalar.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Ainda sem HTTPS?** O `deploy/compose` arranca o servidor por trás do seu
próprio terminador TLS (o Caddy), em qualquer rede, sem domínio e sem conta
com ninguém. A partir de uma cópia local deste repositório:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

O `OBSYNC_HOST` é o nome que os seus dispositivos vão escrever. Só tem de
resolver na sua própria rede. O `OBSYNC_BIND_ADDRESS` é o endereço deste
anfitrião em que as portas 80 e 443 são publicadas: um endereço de escuta
limita a interface de destino, não a origem, por isso é a sua firewall que
decide quem lhe chega. O Compose recusa-se a arrancar enquanto não tiver
escolhido. Ambos são explicados em [Executar o servidor](../server.md).

**Já tem HTTPS à frente** da máquina, através de um proxy inverso ou de um
túnel em que confia? Execute o servidor isolado. Ele fala HTTP simples na
porta 8080 e o seu terminador reencaminha para ele:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Ler o token de configuração

No primeiro arranque, o servidor emite um token de configuração e escreve-o no
seu volume de diário, com modo 0600, e nunca o regista. O token cria a sua
conta uma vez e continua depois a ser, durante toda a vida do servidor, o
início de sessão de recuperação do painel: guarde-o com o mesmo cuidado que a
frase de recuperação. Leia-o a partir do próprio contentor, sem imagem auxiliar. No
caminho Compose:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

No caminho do servidor isolado:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Confiar no certificado, uma vez por dispositivo (caminho Compose)

O Caddy emitiu o certificado a partir de uma autoridade que gerou no primeiro
arranque, por isso é preciso dizer a cada dispositivo, uma vez, que confie
nessa autoridade. Exporte o certificado de raiz:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Instale o `obsync-root.crt` em cada dispositivo. Os passos para macOS,
Windows, Linux, iOS e Android estão em
[Confiar na autoridade de certificação, uma vez por dispositivo](../server.md#trust-the-certificate-authority-once-per-device).
No iOS, confiar no certificado é um segundo interruptor depois de o instalar.

### 4. Configurar o primeiro dispositivo

1. Definições → Plugins não oficiais → Procurar → **Self Hosted Private
   Sync** → Instalar → Ativar.
2. Nas definições do plugin, defina o **Server URL** para o seu servidor, com
   a porta incluída quando não for a 443: `https://sync.example.org`.

   ![O separador de definições do plugin: o campo Server URL com um nome de anfitrião de demonstração, a caixa dos cabeçalhos da edge e a linha Connection com os seus botões Check e Open dashboard](../assets/settings-server.png)

3. Escolha agora **Whole vault** ou **Selected folders only**. Depois de um
   dispositivo ter sincronizado, a sua seleção só pode estreitar.
4. Cole o token de configuração em **First-time setup** e selecione
   **Set up**. Escreva a frase de recuperação de 24 palavras e guarde-a fora
   deste dispositivo.

   ![A secção This device do separador de definições: a linha Pairing com Pair this device e Pair a new device, a linha First-time setup com o campo Setup token e o botão Set up, e a linha Vault key](../assets/settings-setup.png)

### 5. Emparelhar o segundo dispositivo

1. Instale e ative lá o plugin, defina o mesmo **Server URL** e escolha as
   pastas dele.
2. No primeiro dispositivo, execute **Pair a new device**. Mostra um código
   válido durante dez minutos.

   ![A caixa de diálogo Pair a new device no primeiro dispositivo, com o código tapado, os botões Copy code e Copy link e a linha Waiting for the new device](../assets/pair-new-device.png)

3. No segundo dispositivo, abra **Pair this device**, cole o código e
   selecione **Pair**.

   ![A caixa de diálogo Pair this device no segundo dispositivo, com o campo Pairing code vazio e o botão Pair](../assets/pair-this-device.png)

4. De volta ao primeiro dispositivo, aprove o novo dispositivo pelo nome.
   Edite uma nota em qualquer um deles; aparece no outro em segundos.

   ![O primeiro dispositivo a perguntar se deve aprovar o novo dispositivo pelo nome, com os botões Approve e Reject](../assets/pair-approve.png)

   ![O segundo dispositivo a mostrar a nota escrita no primeiro dispositivo, com a barra de estado a dizer obsync idle](../assets/first-sync.png)

Toda a troca de emparelhamento, num curto ciclo:

![Animação: o código de emparelhamento mostrado no primeiro dispositivo, colado no segundo, aprovado no primeiro, e a primeira nota a chegar ao segundo](../assets/pairing.gif)

As capturas de ecrã de telemóvel ainda não estão neste repositório; são
tiradas nos dispositivos do próprio responsável pelo projeto e acrescentadas
quando uma sessão de validação as registar.

Cada passo por extenso, com o que cada ecrã pede e porquê:
[Arranque rápido](../quickstart.md).

**A experimentar num só computador?** Num computador, o plugin também aceita
um endereço `http://` simples, por isso `http://127.0.0.1:8080` chega ao
servidor isolado acima sem terminador. Os telemóveis não: o Obsidian no iOS e
no Android recusa HTTP simples.

## Avançado: Cloudflare

A instalação de referência não tem **nenhum nome de anfitrião público**. Um
Cloudflare Tunnel liga a rede privada do servidor à Cloudflare, uma rota
privada diz à Cloudflare que endereços vivem atrás desse túnel, e o cliente
Cloudflare One em cada dispositivo leva lá o Server URL. Nada é acessível a
partir da internet, e as primeiras sincronizações grandes não passam por um
nome de anfitrião público. A outra variante, um nome de anfitrião público
atrás do Cloudflare Access com um token de serviço em **Edge service-token
headers** e `OBSYNC_EDGE=cloudflare` no servidor, também é suportada. Ambas,
passo a passo: [Cloudflare](cloudflare.md).

## Outras formas de chegar ao seu servidor

Uma linha para cada uma, sem tutorial. Escolha o que escolher, o plugin
precisa de HTTPS com um certificado em que todos os dispositivos confiem, e o
próprio servidor mantém-se em HTTP simples por trás desse terminador.

- **Só LAN.** O caminho Compose acima, acessível apenas em casa. O mais
  simples; sem sincronização fora de casa.
- **WireGuard.** A sua própria VPN de volta à sua rede. O mais rápido e
  inteiramente seu; leva uma configuração de par em cada dispositivo e mantém
  um ponto de extremidade acessível.
- **Tailscale.** Uma malha WireGuard gerida, com nomes próprios. O que exige
  menos configuração nos dispositivos; um terceiro coordena a malha, e cabe-lhe
  a si ler os limites do plano dele.
- **Um proxy inverso com TLS automático**, como o Caddy num nome público. Um
  certificado publicamente fidedigno e um endereço permanente; o servidor fica
  então acessível a partir da internet, e o proxy e as suas atualizações ficam
  a seu cargo.
- **Cloudflare Tunnel.** Ver acima. Sem porta de entrada aberta; um fornecedor
  no caminho, com condições próprias.

Aquilo de que um dispositivo em mobilidade precisa, qualquer que seja a sua
escolha (a rota, o nome, o certificado, o pedido de rede local do iOS, a
firewall):
[Chegar ao servidor a partir de fora da sua LAN](../server.md#reaching-it-from-outside-your-lan).

## Resolução de problemas

| Sintoma | Causa provável | Primeira coisa a tentar |
| --- | --- | --- |
| `obsync: offline` | O dispositivo não consegue chegar ao Server URL | Abra o URL num navegador no mesmo dispositivo; verifique a porta, o HTTPS e a rota |
| Um telemóvel não se liga enquanto um computador sincroniza | O certificado privado não é fidedigno no telemóvel | Instale o certificado de raiz; no iOS, ative-o também em «Certificate Trust Settings» |
| `401 stale_timestamp` | Um relógio está errado em mais de 300 segundos | Ative a hora automática, no dispositivo ou no servidor |
| `403 device_pending` | Ainda ninguém aprovou o dispositivo | Aprove-o pelo nome no dispositivo a partir do qual emparelhou |
| Um ficheiro nunca chega | Está fora da seleção de pastas, ou acima do limite de tamanho de um telemóvel | Verifique **Sync folders on this device**; no telemóvel, execute **Show remote-only files** |

Todos os outros sintomas, todos os códigos de erro e como recolher um
relatório que valha a pena enviar:
[Resolução de problemas](../troubleshooting.md).

## Documentação

| Página | O que responde |
| --- | --- |
| [Arranque rápido](../quickstart.md) | O primeiro dispositivo e o segundo, cada passo por extenso |
| [Executar o servidor](../server.md) | Docker, Compose com Caddy, certificados, cópias de segurança, chegar ao servidor a partir de fora da sua LAN |
| [Cloudflare](cloudflare.md) | Túnel com rota privada e o cliente Cloudflare One, ou um nome de anfitrião público atrás do Access |
| [Kubernetes](../../chart/README.md) | Instalar o servidor com o chart Helm assinado |
| [Utilização diária](../daily-use.md) | Comandos, a barra de estado, o que sincroniza e o que não sincroniza, restaurar uma versão, o painel |
| [Definições](../settings.md) | Todas as definições, o seu valor predefinido e quando as mudar |
| [Resolução de problemas](../troubleshooting.md) | Sintoma, causa, solução e como recolher um relatório |
| [Conflitos](../conflicts.md) | O que é uma cópia de conflito e o que fazer com ela |
| [Recuperação](../recovery.md) | Um dispositivo perdido, um servidor perdido, um servidor mudado de sítio, um token rodado |
| [Instalar e atualizar](../community-plugin.md) | O diretório do Obsidian, as atualizações, a guarda das credenciais, a revisão da listagem |
| [Modelo de ameaças](../threat-model.md) | O que está defendido e o que não está |
| [O modelo de ameaças do painel](../security/dashboard.md) | Sessões, início de sessão, revogação, riscos residuais |
| [Arquitetura](../architecture.md) | Como está construído todo o sistema, e todas as variáveis de ambiente |
| [Protocolo](../protocol.md) | O contrato de comunicação entre o plugin e o servidor |
| [Armazenamento](../storage.md) | Volumes, durabilidade, retenção, limpeza e todas as recusas |
| [Validação](../validation.md) | O plano de validação em dispositivos e o que significa «pronto» |
| [Lançamentos](../release.md) | Como um lançamento é preparado, assinado e auditado |
| [Traduções](../translations.md) | Em que línguas existem os guias, e como são mantidos atuais |
| [`CHANGELOG.md`](../../CHANGELOG.md) | O que mudou em cada versão |
| [`SECURITY.md`](../../SECURITY.md) | A postura, as versões suportadas e como comunicar uma vulnerabilidade |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Como trabalhar neste repositório |

## Perguntas, erros e segurança

- **Uma pergunta, ou algo que não tem a certeza se é um erro:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Um erro:** [abra um issue](https://github.com/snaraj/obsync/issues/new/choose)
  com o modelo de relatório de erro e o relatório descrito em
  [Resolução de problemas](../troubleshooting.md). Não inclua nenhum token,
  nenhuma frase de recuperação e nenhum endereço que não publicaria.
- **Uma suspeita de vulnerabilidade:** em privado, através do
  [`SECURITY.md`](../../SECURITY.md) — nunca num issue público.

## Licença

MIT. Ver [`LICENSE`](../../LICENSE).
