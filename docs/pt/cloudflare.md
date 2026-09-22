> Esta tradução segue o [original em inglês](../cloudflare.md). O texto em inglês é o canónico; os comandos, as opções, os URL e os marcadores de posição não mudam.

# Cloudflare

Duas maneiras de colocar a Cloudflare entre os seus dispositivos e o seu
servidor, e qual delas a instalação de referência utiliza. Nenhuma é
obrigatória: o servidor não conhece nenhum fornecedor pelo nome, e
[Executar o servidor](../server.md) não precisa de conta em lado nenhum. Esta
página é para si se quiser chegar ao servidor fora de casa sem abrir uma porta
no router, ou se quiser um nome de anfitrião publicado com uma política de
acesso à frente.

Os menus da Cloudflare e as condições dos seus planos mudam. Cada passo
abaixo indica o caminho de menu tal como a documentação da Cloudflare o dava
em 2026-09-22; consulte a página actual antes de confiar num limite ou num
preço.

## Qual a variante

| Variante | O que os dispositivos vêem | O que a internet vê | Primeira sincronização grande |
| --- | --- | --- | --- |
| **Rota privada** (a instalação de referência) | o seu próprio endereço privado e o seu nome, através do cliente Cloudflare One | nada: nem nome de anfitrião nem porta aberta | tráfego de rede privada, sem passar por um nome de anfitrião público |
| **Nome de anfitrião público com Access** | um nome público, uma política de Access, um token de serviço no plugin | o nome de anfitrião, atrás do Access | encaminhado pela Cloudflare, nas condições do fornecedor para ficheiros grandes |

A rota privada é a referência porque o servidor permanece invisível e porque
a própria documentação da Cloudflare envia as transferências grandes por
aí: uma rota por nome de anfitrião público faz passar o tráfego pela
Cloudflare, e nos planos Free, Pro e Business as condições específicas do
serviço exigem um serviço pago para vídeo e outros ficheiros grandes,
enquanto uma rota de rede privada os transporta como tráfego seu. Faça a
primeira sincronização grande na LAN em qualquer das variantes.

O que quer que termine o TLS lê as suas credenciais e nunca as suas notas:
cada bloco e cada manifesto são cifrados no dispositivo, e nenhuma chave que
os decifre atravessa a rede ([modelo de ameaças](../threat-model.md)). Na
rota privada, o terminador é seu, dentro da sua rede. No nome de anfitrião
público, a edge também é um terminador.

## Variante A: uma rota privada e o cliente Cloudflare One

O servidor mantém um endereço privado na sua própria rede. Ao lado corre um
conector de túnel, uma rota diz à Cloudflare que endereços vivem atrás desse
túnel, e o cliente Cloudflare One (antigo WARP) em cada dispositivo leva o
tráfego para esses endereços através do túnel. O URL do servidor que os seus
dispositivos escrevem é um nome privado que resolve para esse endereço
privado.

O que precisa: uma conta Cloudflare com uma organização Zero Trust (um «nome
de equipa»), uma máquina na rede do servidor que possa correr o conector do
túnel, e o cliente Cloudflare One em cada dispositivo que vá sincronizar fora
de casa.

1. **Crie um túnel.** No painel da Cloudflare, vá a **Networking** >
   **Tunnels** e crie um túnel `cloudflared`. Corra o conector que ele lhe dá
   numa máquina dentro da rede do servidor: no cluster ao lado do servidor,
   ou no mesmo anfitrião.
2. **Encaminhe o endereço privado do servidor pelo túnel.** Vá a
   **Networking** > **Routes**, escolha **Create route** > **Tunnel CIDR**,
   seleccione o túnel e introduza o endereço privado ou a sub-rede do
   servidor. Um endereço chega; uma sub-rede pode ser alargada mais tarde.
3. **Inscreva cada dispositivo.** Instale o cliente Cloudflare One, escreva o
   nome da sua equipa, conclua a autenticação que a sua organização exigir e
   ligue a ligação. No iOS e no Android o cliente pede para instalar um
   perfil de VPN; aceite. Defina as permissões de inscrição de dispositivos
   de modo que só a sua identidade os possa inscrever.
4. **Envie a gama privada pelo cliente.** Na configuração de Split Tunnels do
   cliente, garanta que o endereço do passo 2 é encaminhado pelo cliente. No
   modo **Exclude**, retire o bloco RFC 1918 que o contém e volte a
   adicionar as gamas que ainda quer excluir; no modo **Include**, adicione
   o endereço ou a sub-rede.
5. **Faça o nome resolver no dispositivo.** O plugin envia cada pedido para o
   URL do servidor que escreveu, por isso esse nome tem de resolver no
   dispositivo em mobilidade: uma rota por nome de anfitrião, Local Domain
   Fallback para o seu próprio resolvedor, ou uma entrada DNS privada. Um
   nome que resolve para um endereço que o cliente não encaminha falha
   exactamente como um servidor desligado.
6. **Termine o TLS por si.** A rota leva o seu tráfego até ao seu próprio
   terminador: um ingress ou um proxy inverso à frente do servidor com um
   certificado em que todos os dispositivos confiam, como em
   [Executar o servidor](../server.md). O servidor corre com
   `OBSYNC_EDGE=none` e só confia em endereços reencaminhados a partir de
   `OBSYNC_TRUSTED_PROXY_CIDRS`, a gama do próprio terminador.
7. **Opcionalmente, filtre com o Gateway.** Uma política de rede do Gateway
   pode permitir que só os seus dispositivos inscritos cheguem ao endereço e
   à porta do servidor, e bloquear tudo o resto nessa rota.
8. **Verifique a partir de um dispositivo fora da sua rede.** Abra o URL do
   servidor num navegador desse dispositivo e espere a página de início de
   sessão do painel. No plugin, escolha **Check** em **Connection**: uma
   única ida e volta prova o endereço, o certificado e a credencial em
   conjunto.

Compromissos:

- Cada dispositivo que sincroniza corre o cliente Cloudflare One, e o cliente
  tem de estar ligado antes de a sincronização fora de casa funcionar.
- A Cloudflare transporta o tráfego entre o dispositivo e o conector do
  túnel. Deixe a desencriptação TLS do Gateway desligada; o tráfego fica
  então opaco para ela além de endereços, tamanhos e tempos, o que o
  [modelo de ameaças](../threat-model.md) já concede a qualquer caminho de
  rede.
- O conector é um processo na sua rede que mantém aberta uma ligação de
  saída para a Cloudflare. Quando cai, os dispositivos em mobilidade mostram
  `obsync: offline` enquanto a LAN continua a funcionar.

## Variante B: um nome de anfitrião público atrás do Access

O servidor recebe um nome de anfitrião num domínio que tem na Cloudflare. O
túnel publica esse nome para o endereço privado do servidor, e o Cloudflare
Access fica à frente: uma política de identidade para o painel e um token de
serviço para as chamadas à API do plugin. É a variante que a
[integração na plataforma](../platform-onboarding.md) descreve para o cluster
de referência, e a que a instalação de referência não adoptou.

1. **Publique o nome de anfitrião.** Na configuração do túnel, adicione uma
   rota de aplicação publicada do seu nome de anfitrião (`sync.example.com`
   representa o seu) para o endereço HTTP privado do servidor, porta 8080. A
   Cloudflare cria o registo DNS.
2. **Ponha o Access à frente.** Vá a **Zero Trust** > **Access controls** >
   **Applications**, crie uma aplicação **Self-hosted** nesse nome de
   anfitrião e adicione uma política de identidade que só o permita a si,
   por exemplo um PIN de utilização única enviado para o seu próprio
   endereço, para o painel.
3. **Crie um token de serviço para o plugin.** Vá a **Zero Trust** >
   **Access controls** > **Service credentials** > **Service Tokens**, crie
   um e copie o Client ID e o Client Secret; o segredo só é mostrado uma
   vez. Adicione à aplicação uma política **Service Auth** que inclua esse
   token, para os caminhos que o plugin usa (`/v1/*`).
4. **Cole o token no plugin.** Em **Edge service-token headers**, um por
   linha, exactamente como a Cloudflare lhes chama:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Seguem em cada pedido para o URL do servidor, e em mais nenhum.
5. **Diga ao servidor que está atrás da edge.** Execute-o com
   `OBSYNC_EDGE=cloudflare`. Nesse modo, cada pedido tem de trazer os
   cabeçalhos da edge com o endereço de ligação e o identificador do pedido,
   e um pedido que chegue a contornar a edge é recusado com
   `421 edge_required` ([resolução de problemas](../troubleshooting.md#edge_required)).
6. **Verifique.** Abra o nome de anfitrião num navegador e espere o início de
   sessão do Access, depois o painel. No plugin, escolha **Check** em
   **Connection**.

Compromissos:

- O nome de anfitrião é público. O Access recusa desconhecidos, e o servidor
  continua a autenticar por si cada pedido de dispositivo, mas o nome existe
  e é descobrível.
- O token de serviço é uma credencial. Quem o tiver chega à porta da frente
  da API; a autenticação de dispositivos do próprio servidor continua atrás.
  Rode-o na Cloudflare se alguma vez for exposto.
- As transferências grandes passam pela Cloudflare nas condições acima. Faça
  a primeira sincronização grande na LAN.
- Os cabeçalhos da edge com o endereço de ligação e o país são o que a página
  Dispositivos do painel mostra como endereço e país neste modo.

## O que foi provado

A rota privada é a rota da instalação de referência. A
[sessão de 2026-09-14](../validation-runs/2026-09-14.md) regista que nesse
dia não foi exercitada, e porquê; a
[sessão de 2026-09-20](../validation-runs/2026-09-20.md) regista uma sessão
com dispositivos na rota de referência com as verificações de conectividade
e de TLS aprovadas. A variante com nome de anfitrião público não foi
exercitada por nenhuma sessão registada.

## A seguir

- [Executar o servidor](../server.md): o terminador, os volumes, o token de
  configuração.
- [Kubernetes](../../chart/README.md): o chart que a instalação de
  referência utiliza.
- [Integração na plataforma](../platform-onboarding.md): o que o cluster de
  referência acrescentaria para um nome de anfitrião publicado.
- [Resolução de problemas](../troubleshooting.md): `edge_required`,
  `offline` e o certificado.
