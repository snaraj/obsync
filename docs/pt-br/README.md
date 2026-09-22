> Esta tradução acompanha o [original em inglês](../../README.md). O texto em inglês é o canônico; comandos, opções, URLs e marcadores de posição não mudam.

# Self Hosted Private Sync

Sincronização ao vivo, auto-hospedada e criptografada de ponta a ponta para o
[Obsidian](https://obsidian.md): um servidor em Rust sem dependências, com
painel embutido, que você mesmo roda, mais este plugin. Arquivos de qualquer
tamanho, todas as plataformas do Obsidian, sem assinatura, sem terceiros.

Instale em Configurações → Plugins não oficiais → Procurar como **Self Hosted
Private Sync** (id do plugin `obsync-private-sync`), no Obsidian 1.13.0 ou
mais novo.

> [!IMPORTANT]
> Este plugin sincroniza com um servidor que **você** roda. Não existe serviço
> hospedado nem conta com ninguém além de você mesmo: sem o seu próprio
> `obsyncd` acessível por HTTPS, o plugin não tem com o que sincronizar.

> [!IMPORTANT]
> Faça backup do seu cofre antes da primeira sincronização e guarde a frase de
> recuperação de 24 palavras em outro lugar que não o dispositivo que a gerou.
> O servidor guarda apenas texto cifrado e não consegue recuperar um cofre
> para você.

> [!IMPORTANT]
> Não rode este plugin junto de outra solução de sincronização no mesmo cofre
> — Obsidian Sync, uma pasta na nuvem que sincroniza arquivos ou outro plugin
> de sincronização. Dois escritores em um mesmo cofre produzem conflitos que
> nenhum dos dois consegue resolver.

## Antes de confiar nele

Este é um software jovem que sincroniza a única cópia das suas notas.

- **O [`CHANGELOG.md`](../../CHANGELOG.md) é a lista mantida do que se sabe.**
  Leia a entrada da versão em que você está e as entradas acima dela. As
  páginas de release guardam as notas com que foram publicadas; descobertas
  posteriores entram aqui.
- **Atualize todos os dispositivos que sincronizam um cofre.** Um único
  dispositivo deixado em uma versão antiga ainda pode agir pelo comportamento
  antigo e afetar os outros.
- **O que foi exercitado em hardware** está registrado por sessão em
  [`docs/validation-runs/`](../validation-runs/), inclusive o que cada sessão
  não cobriu. Uma plataforma que nenhuma sessão menciona não está comprovada.
- **Uma sucessão de avisos "merged concurrent edits"** em dois dispositivos
  editando a mesma nota: feche o Obsidian em um deles para o outro conseguir
  escoar o trabalho, atualize os dois e então retome.

## O que este plugin acessa

Curto e completo, para você decidir antes de instalar.

- **Um único destino de rede: o seu próprio servidor.** Toda requisição vai
  para a **Server URL** que você digita nas configurações do plugin, e para
  mais nada. Não há telemetria, análise de uso, relatório de falhas,
  publicidade nem serviço de terceiros em nenhum ponto do caminho da
  sincronização. O plugin também nunca baixa nem executa código desse
  servidor.
- **Uma conta nesse servidor, criada por você.** O primeiro dispositivo usa o
  token de configuração que o seu servidor gravou na primeira inicialização;
  todos os outros são pareados a partir de um dispositivo que já sincroniza. A
  sua conta do Obsidian não tem papel nenhum aqui.
- **Obsidian e GitHub, apenas para instalar e atualizar.** O próprio Obsidian
  baixa `main.js`, `manifest.json` e `styles.css` dos GitHub Releases deste
  repositório. Cada release traz também um ZIP do plugin e um manifesto de
  release para quem implanta o servidor; o Obsidian ignora os dois.
- **A sua borda, só se você tiver configurado uma.** Os cabeçalhos que você
  cola em **Edge service-token headers** viajam em toda requisição para a
  Server URL acima, porque o proxy que precisa deles está no caminho até o seu
  servidor.
- **A lista de arquivos do seu cofre.** O plugin lista cada arquivo do cofre
  para decidir o que está no escopo, lê os arquivos dentro da sua seleção de
  pastas e grava o que os outros dispositivos mudaram. Pastas ocultas
  (`.obsidian`, `.git`) e pastas que são links simbólicos são ignoradas.
- **A área de transferência, escrita e nunca lida.** Só os botões
  **Copy code** e **Copy link** em **Pair a new device** escrevem nela. Nada
  no plugin lê a área de transferência.
- **O seu navegador, quando você pede o painel.** **Open dashboard** abre um
  link de login no seu navegador, e só quando esse link está na origem do seu
  próprio servidor.
- **O armazenamento secreto do Obsidian.** A chave do cofre, o segredo do
  dispositivo e quaisquer valores de cabeçalho da borda ficam lá, nunca em
  dados simples do plugin.

O que o servidor pode e o que não pode ver está em
[`SECURITY.md`](../../SECURITY.md) e
[`docs/threat-model.md`](../threat-model.md).

## Sincronizado em cinco passos

O caminho em que este release foi validado, de um cofre vazio a dois
dispositivos sincronizados. Todos os cinco pressupõem que o seu próprio
servidor já está rodando, que é a seção abaixo; cada passo está escrito por
extenso no início rápido.

1. **Instale pelos Plugins não oficiais.** Em Configurações → Plugins não
   oficiais → Procurar, busque **Self Hosted Private Sync** e escolha
   Instalar, depois Ativar — do mesmo jeito que chega qualquer outro plugin do
   Obsidian, em qualquer plataforma.

   ![O navegador de Plugins não oficiais do Obsidian mostrando Self Hosted Private Sync com o seu botão Instalar](../captures/01-install-from-directory.png)

2. **Aponte-o para o seu servidor e faça a configuração.** Abra a aba de
   configurações do plugin, defina **Server URL** para o seu próprio servidor,
   escolha quais pastas este dispositivo sincroniza e então cole o seu token
   de configuração em **First-time setup**.

   ![A aba de configurações do plugin rolada até a seleção de pastas, a linha Pairing e o campo Setup token em First-time setup](../captures/02-first-time-setup.png)

3. **Guarde a frase de recuperação.** A configuração gera a chave do cofre
   neste dispositivo e mostra uma frase de 24 palavras uma única vez: anote-a
   e guarde-a em outro lugar que não este dispositivo, porque o servidor
   guarda apenas texto cifrado e não consegue recuperar um cofre para você.

   ![A caixa de diálogo com a frase de recuperação exibida depois da configuração inicial, com as palavras ocultadas](../captures/03-recovery-phrase.png)

4. **Pareie um segundo dispositivo com um código de uso único.** Execute
   **Pair a new device** no primeiro dispositivo, digite no segundo, dentro de
   dez minutos, o código que ele mostra, e aprove o dispositivo pelo nome — a
   chave do cofre viaja criptografada sob um segredo de pareamento que o
   servidor nunca vê.

   ![A caixa de diálogo Pair a new device no primeiro dispositivo, com o seu código de uso único ocultado](../captures/04-pair-a-new-device.png)

5. **Edite em qualquer um dos dispositivos e veja a mudança chegar.** Digite
   em uma nota em um dispositivo e ela aparece no outro em segundos, nos dois
   sentidos, com a barra de status mostrando o que a sincronização está
   fazendo.

   ![A nota descartável com as edições dos dois dispositivos, com a barra de status da sincronização visível](../captures/05-sync-both-ways.png)

A lista de dispositivos do painel e o seu botão de revogação estão descritos
em [Veja os seus dispositivos](../daily-use.md#see-your-devices) e não foram
exercitados na sessão com dispositivos da 1.0.0 registrada em
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Começar a sincronizar

O caminho correto mais curto: uma máquina sua roda o servidor, todo
dispositivo o alcança por HTTPS e cada dispositivo é pareado uma vez. Entrar
na sua conta do Obsidian não autoriza nada aqui; a única conta é a do seu
servidor.

### 1. Inicie o servidor

Dois jeitos de iniciá-lo. Os dois executam exatamente os bytes que o
publicador assinou: verifique a assinatura, leia o digest da saída verificada
e execute esse digest. `v1.0.6` é o release para o qual esta página foi
escrita; use a tag do release que você está instalando.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Ainda sem HTTPS?** O `deploy/compose` inicia o servidor atrás do seu próprio
terminador TLS (Caddy), em qualquer rede, sem domínio e sem conta com
ninguém. A partir de um checkout deste repositório:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` é o nome que os seus dispositivos vão digitar. Ele só precisa
resolver na sua própria rede. `OBSYNC_BIND_ADDRESS` é o endereço deste host em
que as portas 80 e 443 são publicadas: um endereço de bind limita a interface
de destino, não a de origem, então quem decide quem o alcança é o seu
firewall. O Compose se recusa a iniciar enquanto você não escolher. Os dois
estão explicados em [Rodar o servidor](../server.md).

**Já tem HTTPS na frente** da máquina, vindo de um proxy reverso ou de um
túnel em que você confia? Rode o servidor puro. Ele fala HTTP simples na porta
8080, e o seu terminador encaminha para ele:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Leia o token de configuração

Na primeira inicialização, o servidor emite um token de configuração e o grava
no seu volume de journal, modo 0600, nunca registrado em log. O token cria a
sua conta uma vez e, depois disso, continua sendo o login de recuperação do
painel por toda a vida do servidor: guarde-o com o mesmo cuidado que a frase
de recuperação. Leia-o do próprio contêiner, sem imagem auxiliar. No caminho
do Compose:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

No caminho do servidor puro:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Confie no certificado, uma vez por dispositivo (caminho do Compose)

O Caddy emitiu o certificado a partir de uma autoridade que ele mesmo gerou na
primeira inicialização, então é preciso dizer a cada dispositivo, uma vez, que
confie nessa autoridade. Exporte o certificado raiz:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Instale o `obsync-root.crt` em cada dispositivo. Os passos para macOS,
Windows, Linux, iOS e Android estão em
[Confie na autoridade certificadora, uma vez por dispositivo](../server.md#trust-the-certificate-authority-once-per-device).
No iOS, confiar no certificado é uma segunda opção a ativar, depois de
instalá-lo.

### 4. Configure o primeiro dispositivo

1. Configurações → Plugins não oficiais → Procurar → **Self Hosted Private
   Sync** → Instalar → Ativar.
2. Nas configurações do plugin, defina **Server URL** para o seu servidor, com
   a porta quando ela não for 443: `https://sync.example.org`.

   ![A aba de configurações do plugin: o campo Server URL com um nome de host de demonstração, a caixa dos cabeçalhos da borda e a linha Connection com os seus botões Check e Open dashboard](../assets/settings-server.png)

3. Escolha agora **Whole vault** ou **Selected folders only**. Depois que um
   dispositivo sincroniza, a seleção dele só pode ser reduzida.
4. Cole o token de configuração em **First-time setup** e escolha **Set up**.
   Anote a frase de recuperação de 24 palavras e mantenha-a fora deste
   dispositivo.

   ![A seção This device da aba de configurações: a linha Pairing com Pair this device e Pair a new device, a linha First-time setup com o campo Setup token e o botão Set up, e a linha Vault key](../assets/settings-setup.png)

### 5. Pareie o segundo dispositivo

1. Instale e ative o plugin nele, defina a mesma **Server URL** e escolha as
   pastas dele.
2. No primeiro dispositivo, execute **Pair a new device**. Ele mostra um
   código válido por dez minutos.

   ![A caixa de diálogo Pair a new device no primeiro dispositivo, com o seu código ocultado, com os botões Copy code e Copy link e a linha Waiting for the new device](../assets/pair-new-device.png)

3. No segundo dispositivo, abra **Pair this device**, cole o código e escolha
   **Pair**.

   ![A caixa de diálogo Pair this device no segundo dispositivo, com o campo Pairing code vazio e o botão Pair](../assets/pair-this-device.png)

4. De volta ao primeiro dispositivo, aprove o novo dispositivo pelo nome.
   Edite uma nota em qualquer um dos dois; ela aparece no outro em segundos.

   ![O primeiro dispositivo perguntando se o novo dispositivo deve ser aprovado pelo nome, com os botões Approve e Reject](../assets/pair-approve.png)

   ![O segundo dispositivo mostrando a nota escrita no primeiro dispositivo, com a barra de status exibindo obsync idle](../assets/first-sync.png)

Toda a troca de pareamento, em um loop curto:

![Animação: o código de pareamento mostrado no primeiro dispositivo, colado no segundo, aprovado no primeiro, e a primeira nota chegando no segundo](../assets/pairing.gif)

As capturas de tela de celular ainda não estão neste repositório; elas são
feitas nos dispositivos do próprio mantenedor e acrescentadas quando uma
sessão de validação as registra.

Cada passo por extenso, com o que cada tela pede e por quê:
[Início rápido](../quickstart.md).

**Testando em um só computador?** Em um computador, o plugin também aceita um
endereço `http://` simples, então `http://127.0.0.1:8080` alcança o servidor
puro acima sem terminador. Celulares não: o Obsidian no iOS e no Android
recusa HTTP simples.

## Avançado: Cloudflare

A instalação de referência **não tem nome de host público**. Um Cloudflare
Tunnel conecta a rede privada do servidor à Cloudflare, uma rota privada diz à
Cloudflare quais endereços vivem atrás desse túnel, e o cliente Cloudflare One
em cada dispositivo leva a Server URL até lá. Nada é alcançável a partir da
internet, e as primeiras sincronizações grandes não passam por um nome de host
público. A outra variante, um nome de host público atrás do Cloudflare Access
com um token de serviço em **Edge service-token headers** e
`OBSYNC_EDGE=cloudflare` no servidor, também é suportada. As duas, passo a
passo: [Cloudflare](cloudflare.md).

## Outros jeitos de alcançar o seu servidor

Uma linha para cada, sem tutorial. Seja qual for a sua escolha, o plugin
precisa de HTTPS com um certificado em que todos os dispositivos confiam, e o
próprio servidor fica em HTTP simples atrás desse terminador.

- **Só LAN.** O caminho do Compose acima, alcançável só em casa. O mais
  simples; sem sincronização fora de casa.
- **WireGuard.** A sua própria VPN de volta para a sua rede. O mais rápido e
  inteiramente seu; você carrega uma configuração de peer em cada dispositivo
  e mantém um endpoint alcançável.
- **Tailscale.** Uma malha WireGuard gerenciada, com nomes próprios. O que
  menos exige configuração nos dispositivos; um terceiro coordena a malha, e
  cabe a você ler os limites do plano dele.
- **Um proxy reverso com TLS automático**, como o Caddy em um nome público. Um
  certificado publicamente confiável e um endereço permanente; o servidor fica
  então alcançável a partir da internet, e manter o proxy e as atualizações
  dele em ordem é com você.
- **Cloudflare Tunnel.** Acima. Sem porta de entrada; um provedor no caminho,
  com condições próprias.

O que um dispositivo em trânsito precisa, qualquer que seja a sua escolha (a
rota, o nome, o certificado, o aviso de rede local do iOS, o firewall):
[Alcançá-lo de fora da sua LAN](../server.md#reaching-it-from-outside-your-lan).

## Solução de problemas

| Sintoma | Causa provável | Primeira coisa a tentar |
| --- | --- | --- |
| `obsync: offline` | O dispositivo não consegue alcançar a Server URL | Abra a URL em um navegador no mesmo dispositivo; confira a porta, o HTTPS e a rota |
| Um celular não conecta enquanto um computador sincroniza | O certificado privado não é confiável no celular | Instale o certificado raiz; no iOS, ative-o também em "Certificate Trust Settings" |
| `401 stale_timestamp` | Um relógio está errado em mais de 300 segundos | Ative a hora automática, no dispositivo ou no servidor |
| `403 device_pending` | Ninguém aprovou o dispositivo ainda | Aprove-o pelo nome no dispositivo a partir do qual você pareou |
| Um arquivo nunca chega | Ele está fora da seleção de pastas, ou acima do limite de tamanho de um celular | Confira **Sync folders on this device**; no celular, rode **Show remote-only files** |

Qualquer outro sintoma, cada código de erro e como coletar um relatório que
valha a pena enviar: [Solução de problemas](../troubleshooting.md).

## Documentação

| Página | O que ela responde |
| --- | --- |
| [Início rápido](../quickstart.md) | O primeiro dispositivo e o segundo, cada passo por extenso |
| [Rodar o servidor](../server.md) | Docker, Compose com Caddy, certificados, backups, alcançá-lo de fora da sua LAN |
| [Cloudflare](cloudflare.md) | Túnel com rota privada e o cliente Cloudflare One, ou um nome de host público atrás do Access |
| [Kubernetes](../../chart/README.md) | Instalar o servidor com o chart Helm assinado |
| [Uso diário](../daily-use.md) | Comandos, a barra de status, o que sincroniza e o que não sincroniza, restaurar uma versão, o painel |
| [Configurações](../settings.md) | Cada configuração, o seu padrão e quando mudá-la |
| [Solução de problemas](../troubleshooting.md) | Sintoma, causa, correção e como coletar um relatório |
| [Conflitos](../conflicts.md) | O que é uma cópia de conflito e o que fazer com ela |
| [Recuperação](../recovery.md) | Um dispositivo perdido, um servidor perdido, um servidor que mudou de lugar, um token rotacionado |
| [Instalar e atualizar](../community-plugin.md) | O diretório do Obsidian, as atualizações, a custódia das credenciais, a revisão da listagem |
| [Modelo de ameaças](../threat-model.md) | O que é defendido e o que não é |
| [O modelo de ameaças do painel](../security/dashboard.md) | Sessões, login, revogação, riscos residuais |
| [Arquitetura](../architecture.md) | Como todo o sistema é construído, e cada variável de ambiente |
| [Protocolo](../protocol.md) | O contrato de comunicação entre o plugin e o servidor |
| [Armazenamento](../storage.md) | Volumes, durabilidade, retenção, scrub e cada recusa |
| [Validação](../validation.md) | O plano de validação em dispositivos e o que "pronto" significa |
| [Releases](../release.md) | Como um release é cortado, assinado e auditado |
| [Traduções](../translations.md) | Em quais idiomas os guias existem e como eles são mantidos atualizados |
| [`CHANGELOG.md`](../../CHANGELOG.md) | O que mudou em cada versão |
| [`SECURITY.md`](../../SECURITY.md) | Postura, versões suportadas e como relatar uma vulnerabilidade |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Como trabalhar neste repositório |

## Dúvidas, bugs e segurança

- **Uma dúvida, ou algo que você não tem certeza se é um bug:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Um bug:** [abra uma issue](https://github.com/snaraj/obsync/issues/new/choose)
  com o modelo de relato de bug e o relatório descrito na
  [Solução de problemas](../troubleshooting.md). Não inclua nenhum token,
  nenhuma frase de recuperação e nenhum endereço que você não publicaria.
- **Uma suspeita de vulnerabilidade:** em caráter privado, pelo
  [`SECURITY.md`](../../SECURITY.md) — nunca como uma issue pública.

## Licença

MIT. Veja [`LICENSE`](../../LICENSE).
