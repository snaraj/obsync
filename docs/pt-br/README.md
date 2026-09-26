> Esta tradução acompanha o [original em inglês](../../README.md). O texto em inglês é o canônico; comandos, opções, URLs e marcadores de posição não mudam.

<img src="../../brand/obsync-icon-256.png" alt="ícone do obsync: dois anéis entrelaçados" width="96" height="96">

# Self Hosted Private Sync

Sincronização ao vivo, auto-hospedada e criptografada de ponta a ponta para o
[Obsidian](https://obsidian.md): um servidor em Rust sem dependências, com
painel embutido, que você mesmo roda, mais este plugin. Arquivos de qualquer
tamanho, todas as plataformas do Obsidian, sem assinatura, sem terceiros.

Instale em Configurações → Plugins não oficiais → Procurar como **Self Hosted
Private Sync** (id do plugin `obsync-private-sync`), no Obsidian 1.13.0 ou
mais novo.

**Novo por aqui? Comece pelo [guia de configuração](https://snaraj.github.io/obsync/setup/) (em inglês).** Ele ajuda você a escolher como seus dispositivos chegam ao servidor e percorre cada opção passo a passo. No Obsidian: Configurações → Self Hosted Private Sync → Setup guide.

> [!IMPORTANT]
> - Ele sincroniza com um servidor que **você** roda: sem serviço hospedado, sem conta em outro lugar.
> - Faça backup do seu cofre antes; guarde a frase de recuperação de 24 palavras fora do dispositivo que a gerou.
> - Nunca o rode junto de outra sincronização (Obsidian Sync, uma pasta na nuvem, outro plugin) no mesmo cofre.
> - Software jovem: leia a entrada do [`CHANGELOG.md`](../../CHANGELOG.md) da sua versão, atualize todos os dispositivos e saiba o que cada [sessão de validação](../validation-runs/) cobriu.

## O que este plugin acessa

- **O seu servidor, e mais nada.** Toda requisição vai para a **Server URL** que você digita; sem telemetria, sem terceiros.
- **Uma conta nesse servidor**, criada a partir do token de configuração; a sua conta do Obsidian não tem papel nenhum.
- **Os GitHub Releases, pelo Obsidian**, para instalar e atualizar; o Obsidian ignora os arquivos extras do release.
- **A lista de arquivos do seu cofre**, para decidir o que sincronizar; pastas ocultas (`.obsidian`, `.git`) e pastas que são links simbólicos são ignoradas.
- **A área de transferência, apenas escrita** pelos botões **Copy code** e **Copy link** em **Pair a new device**, nunca lida.

O que o servidor pode e o que não pode ver: [`SECURITY.md`](../../SECURITY.md) e o [modelo de ameaças](../threat-model.md).

## Começar a sincronizar

Cinco passos do zero a dois dispositivos sincronizados. `v1.0.6` é o release
para o qual esta página foi escrita; use a tag que você está instalando.

### 1. Inicie o servidor

Verifique a assinatura e então execute exatamente o digest que ela imprimiu:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

O caminho simples é o Compose com o Caddy, a partir de um checkout deste
repositório: HTTPS em qualquer rede, sem domínio e sem conta em lugar nenhum.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` é o nome que os seus dispositivos vão digitar; ele só precisa
resolver na sua própria rede. `OBSYNC_BIND_ADDRESS` é o endereço em que as
portas 80 e 443 são publicadas: um endereço de bind limita a interface de
destino, não a de origem, então quem decide quem o alcança é o seu firewall.
O Compose se recusa a iniciar enquanto você não escolher.

Já tem HTTPS na frente, vindo de um proxy ou de um túnel em que você confia?
Rode o servidor puro: [Rodar o servidor](../server.md).

### 2. Leia o token de configuração

Na primeira inicialização, o servidor emite um token de configuração e o grava
no seu volume de journal, modo 0600, nunca registrado em log. Ele cria a sua
conta uma vez e continua sendo o login de recuperação do painel: guarde-o com
o mesmo cuidado que a frase de recuperação. Leia-o do contêiner:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Confie no certificado, uma vez por dispositivo

O Caddy assina com uma autoridade que ele mesmo gerou na primeira
inicialização; cada dispositivo precisa confiar nela uma vez. Exporte o
certificado raiz e instale-o em cada plataforma como mostra
[Rodar o servidor](../server.md#trust-the-certificate-authority-once-per-device);
no iOS, confiar nele é uma segunda opção a ativar depois de instalá-lo.

### 4. Configure o primeiro dispositivo

1. Configurações → Plugins não oficiais → Procurar → **Self Hosted Private
   Sync** → Instalar → Ativar.
2. Defina **Server URL** para o seu servidor (`https://sync.example.org`, com
   a porta quando ela não for 443) e então escolha **Whole vault** ou
   **Selected folders only**; depois a seleção só pode ser reduzida.

   ![A aba de configurações do plugin: o campo Server URL com um nome de host de demonstração, a caixa dos cabeçalhos da borda e a linha Connection com os seus botões Check e Open dashboard](../assets/settings-server.png)

3. Cole o token de configuração em **Setup or recover**, escolha **Set up or recover** e
   anote a frase de recuperação de 24 palavras.

   ![A seção This device da aba de configurações: a linha Pairing com Pair this device e Pair a new device, a linha First-time setup com o campo Setup token e o botão Set up, e a linha Vault key](../assets/settings-setup.png)

### 5. Pareie o segundo dispositivo

1. Instale o plugin nele com a mesma **Server URL**; no primeiro dispositivo,
   execute **Pair a new device** para obter um código válido por dez minutos.

   ![A caixa de diálogo Pair a new device no primeiro dispositivo, com o seu código ocultado, com os botões Copy code e Copy link e a linha Waiting for the new device](../assets/pair-new-device.png)

2. No segundo dispositivo, abra **Pair this device**, cole o código e escolha
   **Pair**.
3. De volta ao primeiro dispositivo, aprove-o pelo nome. Edite uma nota em
   qualquer um dos dois; ela aparece no outro em segundos.

   ![O primeiro dispositivo perguntando se o novo dispositivo deve ser aprovado pelo nome, com os botões Approve e Reject](../assets/pair-approve.png)

![Animação: o código de pareamento mostrado no primeiro dispositivo, colado no segundo, aprovado no primeiro, e a primeira nota chegando no segundo](../assets/pairing.gif)

Testando em um só computador? `http://127.0.0.1:8080` alcança o servidor puro
em um computador; o Obsidian no iOS e no Android recusa HTTP simples.

As capturas de tela de celular ainda não estão neste repositório; elas são
feitas nos dispositivos do próprio mantenedor e acrescentadas quando uma
sessão de validação as registra.

Cada passo por extenso: [Início rápido](../quickstart.md).

## Avançado: Cloudflare

A instalação de referência não tem nome de host público: um Cloudflare Tunnel
e uma rota privada alcançam a rede do servidor, e o cliente Cloudflare One de
cada dispositivo leva a Server URL até lá. Um nome de host público atrás do
Cloudflare Access, com um token de serviço em **Edge service-token headers** e
`OBSYNC_EDGE=cloudflare`, também funciona. As duas variantes, passo a passo:
[Cloudflare](cloudflare.md).

## Outros jeitos de alcançar o seu servidor

Seja qual for a sua escolha, o plugin precisa de HTTPS com um certificado em
que todos os dispositivos confiam; o servidor fica em HTTP simples atrás desse
terminador.

- **Só LAN.** O caminho do Compose acima, alcançável só em casa; sem sincronização fora de casa.
- **WireGuard.** A sua própria VPN de volta para casa: a mais rápida e inteiramente sua; uma configuração de peer em cada dispositivo.
- **Tailscale.** Uma malha WireGuard gerenciada: o que menos exige configuração; um terceiro a coordena, nas condições do plano dele.
- **Um proxy reverso com TLS automático**, como o Caddy em um nome público: alcançável a partir da internet, e mantê-lo atualizado é com você.
- **Cloudflare Tunnel.** Acima. Sem porta de entrada; um provedor no caminho, com condições próprias.

O que um dispositivo em trânsito precisa (a rota, o nome, o certificado, o
firewall, o aviso de rede local do iOS):
[Alcançá-lo de fora da sua LAN](../server.md#reaching-it-from-outside-your-lan).

## Solução de problemas

| Sintoma | Causa provável | Primeira coisa a tentar |
| --- | --- | --- |
| `obsync: offline` | O dispositivo não consegue alcançar a Server URL | Abra a URL em um navegador nele; confira a porta, o HTTPS e a rota |
| Um celular não conecta enquanto um computador sincroniza | O certificado privado não é confiável no celular | Instale o certificado raiz; no iOS, ative-o também em "Certificate Trust Settings" |
| `401 stale_timestamp` | Um relógio está errado em mais de 300 segundos | Ative a hora automática, no dispositivo ou no servidor |
| `403 device_pending` | Ninguém aprovou o dispositivo ainda | Aprove-o pelo nome no dispositivo a partir do qual você pareou |
| Um arquivo nunca chega | Ele está fora da seleção de pastas, ou acima do limite de tamanho de um celular | Confira **Sync folders on this device**; no celular, rode **Show remote-only files** |

Qualquer outro sintoma, cada código de erro e como relatar um deles:
[Solução de problemas](../troubleshooting.md).

## Documentação

[Início rápido](../quickstart.md) · [Rodar o servidor](../server.md) ·
[Cloudflare](cloudflare.md) · [Uso diário](../daily-use.md) ·
[Configurações](../settings.md) · [Solução de problemas](../troubleshooting.md) ·
[Recuperação](../recovery.md) · [Changelog](../../CHANGELOG.md)

Tudo o mais: [docs/README.md](../README.md).

## Dúvidas, bugs e segurança

- **Uma dúvida, ou algo que você não tem certeza se é um bug:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Um bug:** [abra uma issue](https://github.com/snaraj/obsync/issues/new/choose) com o relatório que a [Solução de problemas](../troubleshooting.md) descreve; sem token, sem frase de recuperação, sem nenhum endereço que você não publicaria.
- **Uma suspeita de vulnerabilidade:** em caráter privado, pelo [`SECURITY.md`](../../SECURITY.md), nunca como uma issue pública.

## Licença

MIT. Veja [`LICENSE`](../../LICENSE).
