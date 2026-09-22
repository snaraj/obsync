> Esta tradução acompanha o [original em inglês](../cloudflare.md). O texto em inglês é o canônico; comandos, opções, URLs e marcadores de posição não mudam.

# Cloudflare

Dois jeitos de colocar a Cloudflare entre os seus dispositivos e o seu
servidor, e qual deles a instalação de referência usa. Nenhum é obrigatório:
o servidor não conhece nenhum provedor pelo nome, e
[Rodar o servidor](../server.md) não precisa de conta em lugar nenhum. Esta
página é para você se quiser alcançar o servidor fora de casa sem abrir uma
porta no roteador, ou se quiser um nome de host publicado com uma política de
acesso na frente.

Os menus da Cloudflare e as condições dos planos mudam. Cada passo abaixo
indica o caminho de menu como a documentação da Cloudflare mostrava em
2026-09-22; confira a página atual antes de confiar em um limite ou em um
preço.

## Qual variante

| Variante | O que os dispositivos veem | O que a internet vê | Primeira sincronização grande |
| --- | --- | --- | --- |
| **Rota privada** (a instalação de referência) | o seu próprio endereço privado e o seu nome, pelo cliente Cloudflare One | nada: nem nome de host nem porta aberta | tráfego de rede privada, sem passar por um nome de host público |
| **Nome de host público com Access** | um nome público, uma política do Access, um token de serviço no plugin | o nome de host, atrás do Access | passa pela Cloudflare, nas condições do provedor para arquivos grandes |

A rota privada é a referência porque o servidor fica invisível e porque a
própria documentação da Cloudflare manda as transferências grandes por ela:
uma rota por nome de host público faz o tráfego passar pela Cloudflare, e nos
planos Free, Pro e Business as condições específicas do serviço exigem um
serviço pago para vídeo e outros arquivos grandes, enquanto uma rota de rede
privada os transporta como tráfego seu. Faça a primeira sincronização grande
na LAN em qualquer uma das variantes.

O que quer que termine o TLS lê as suas credenciais e nunca as suas notas:
cada bloco e cada manifesto são criptografados no dispositivo, e nenhuma
chave capaz de decifrá-los atravessa a rede
([modelo de ameaças](../threat-model.md)). Na rota privada, o terminador é
seu, dentro da sua rede. No nome de host público, a borda também é um
terminador.

## Variante A: uma rota privada e o cliente Cloudflare One

O servidor mantém um endereço privado na sua própria rede. Ao lado dele roda
um conector de túnel, uma rota diz à Cloudflare quais endereços vivem atrás
desse túnel, e o cliente Cloudflare One (antigo WARP) em cada dispositivo
leva o tráfego para esses endereços pelo túnel. A URL do servidor que os seus
dispositivos digitam é um nome privado que resolve para esse endereço
privado.

O que você precisa: uma conta Cloudflare com uma organização Zero Trust (um
"nome de equipe"), uma máquina na rede do servidor que possa rodar o conector
do túnel, e o cliente Cloudflare One em cada dispositivo que vai sincronizar
fora de casa.

1. **Crie um túnel.** No painel da Cloudflare, vá em **Networking** >
   **Tunnels** e crie um túnel `cloudflared`. Rode o conector que ele fornece
   em uma máquina dentro da rede do servidor: no cluster ao lado do servidor,
   ou no mesmo host.
2. **Roteie o endereço privado do servidor pelo túnel.** Vá em
   **Networking** > **Routes**, escolha **Create route** > **Tunnel CIDR**,
   selecione o túnel e informe o endereço privado ou a sub-rede do servidor.
   Um endereço basta; uma sub-rede pode ser ampliada depois.
3. **Registre cada dispositivo.** Instale o cliente Cloudflare One, digite o
   nome da sua equipe, conclua o login que a sua organização exigir e ligue a
   conexão. No iOS e no Android o cliente pede para instalar um perfil de
   VPN; aceite. Configure as permissões de registro de dispositivos para que
   só a sua identidade possa registrá-los.
4. **Mande a faixa privada pelo cliente.** Na configuração de Split Tunnels do
   cliente, garanta que o endereço do passo 2 seja roteado pelo cliente. No
   modo **Exclude**, remova o bloco RFC 1918 que o contém e adicione de volta
   as faixas que ainda quer excluir; no modo **Include**, adicione o endereço
   ou a sub-rede.
5. **Faça o nome resolver no dispositivo.** O plugin manda cada requisição
   para a URL do servidor que você digitou, então esse nome tem que resolver
   no dispositivo em trânsito: uma rota por nome de host, Local Domain
   Fallback para o seu próprio resolvedor, ou uma entrada de DNS privado. Um
   nome que resolve para um endereço que o cliente não roteia falha
   exatamente como um servidor desligado.
6. **Termine o TLS você mesmo.** A rota leva o seu tráfego até o seu próprio
   terminador: um ingress ou um proxy reverso na frente do servidor com um
   certificado em que todos os dispositivos confiam, como em
   [Rodar o servidor](../server.md). O servidor roda com `OBSYNC_EDGE=none`
   e só confia em endereços encaminhados a partir de
   `OBSYNC_TRUSTED_PROXY_CIDRS`, a faixa do próprio terminador.
7. **Se quiser, filtre com o Gateway.** Uma política de rede do Gateway pode
   permitir que só os seus dispositivos registrados alcancem o endereço e a
   porta do servidor, e bloquear todo o resto nessa rota.
8. **Verifique de um dispositivo fora da sua rede.** Abra a URL do servidor
   em um navegador nesse dispositivo e espere a página de login do painel. No
   plugin, escolha **Check** em **Connection**: uma única ida e volta prova o
   endereço, o certificado e a credencial juntos.

Prós e contras:

- Cada dispositivo que sincroniza roda o cliente Cloudflare One, e o cliente
  precisa estar conectado para a sincronização fora de casa funcionar.
- A Cloudflare transporta o tráfego entre o dispositivo e o conector do túnel.
  Deixe a descriptografia TLS do Gateway desligada; o tráfego fica então
  opaco para ela além de endereços, tamanhos e horários, o que o
  [modelo de ameaças](../threat-model.md) já concede a qualquer caminho de
  rede.
- O conector é um processo na sua rede que mantém aberta uma conexão de saída
  para a Cloudflare. Quando ele cai, os dispositivos em trânsito mostram
  `obsync: offline` enquanto a LAN continua funcionando.

## Variante B: um nome de host público atrás do Access

O servidor ganha um nome de host em um domínio que você tem na Cloudflare. O
túnel publica esse nome para o endereço privado do servidor, e o Cloudflare
Access fica na frente: uma política de identidade para o painel e um token de
serviço para as chamadas de API do plugin. É a variante que a
[integração à plataforma](../platform-onboarding.md) descreve para o cluster
de referência, e a que a instalação de referência não adotou.

1. **Publique o nome de host.** Na configuração do túnel, adicione uma rota
   de aplicação publicada do seu nome de host (`sync.example.com` representa
   o seu) para o endereço HTTP privado do servidor, porta 8080. A Cloudflare
   cria o registro DNS.
2. **Coloque o Access na frente.** Vá em **Zero Trust** > **Access controls**
   > **Applications**, crie uma aplicação **Self-hosted** nesse nome de host
   e adicione uma política de identidade que permita só você, por exemplo um
   PIN de uso único enviado para o seu próprio endereço, para o painel.
3. **Crie um token de serviço para o plugin.** Vá em **Zero Trust** >
   **Access controls** > **Service credentials** > **Service Tokens**, crie
   um e copie o Client ID e o Client Secret; o segredo é mostrado uma única
   vez. Adicione à aplicação uma política **Service Auth** que inclua esse
   token, para os caminhos que o plugin usa (`/v1/*`).
4. **Cole o token no plugin.** Em **Edge service-token headers**, um por
   linha, exatamente como a Cloudflare os chama:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Eles vão em cada requisição para a URL do servidor, e em mais nenhuma.
5. **Diga ao servidor que ele está atrás da borda.** Rode-o com
   `OBSYNC_EDGE=cloudflare`. Nesse modo, cada requisição precisa trazer os
   cabeçalhos da borda com o endereço de conexão e o identificador da
   requisição, e uma requisição que chega contornando a borda é recusada com
   `421 edge_required` ([solução de problemas](../troubleshooting.md#edge_required)).
6. **Verifique.** Abra o nome de host em um navegador e espere o login do
   Access, depois o painel. No plugin, escolha **Check** em **Connection**.

Prós e contras:

- O nome de host é público. O Access recusa desconhecidos, e o servidor
  continua autenticando por conta própria cada requisição de dispositivo,
  mas o nome existe e pode ser descoberto.
- O token de serviço é uma credencial. Quem o tiver chega à porta da frente
  da API; a autenticação de dispositivos do próprio servidor continua atrás.
  Rotacione-o na Cloudflare se um dia for exposto.
- As transferências grandes passam pela Cloudflare nas condições acima. Faça
  a primeira sincronização grande na LAN.
- Os cabeçalhos da borda com o endereço de conexão e o país são o que a
  página Dispositivos do painel mostra como endereço e país nesse modo.

## O que foi comprovado

A rota privada é a rota da instalação de referência. A
[sessão de 2026-09-14](../validation-runs/2026-09-14.md) registra que naquele
dia ela não foi exercitada, e por quê; a
[sessão de 2026-09-20](../validation-runs/2026-09-20.md) registra uma sessão
com dispositivos na rota de referência com as verificações de conectividade
e de TLS aprovadas. A variante com nome de host público não foi exercitada
por nenhuma sessão registrada.

## A seguir

- [Rodar o servidor](../server.md): o terminador, os volumes, o token de
  configuração.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): o chart que a instalação de
  referência usa.
- [Integração à plataforma](../platform-onboarding.md): o que o cluster de
  referência acrescentaria para um nome de host publicado.
- [Solução de problemas](../troubleshooting.md): `edge_required`, `offline`
  e o certificado.
