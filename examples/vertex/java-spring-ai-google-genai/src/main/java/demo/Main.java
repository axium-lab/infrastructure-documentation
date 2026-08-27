package demo;

import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.genai.Client;
import com.google.genai.types.HttpOptions;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.google.genai.GoogleGenAiChatModel;
import org.springframework.ai.google.genai.GoogleGenAiChatOptions;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class Main {

  public static void main(String[] args) {
    SpringApplication.run(Main.class, args);
  }

  @Bean
  Client genAiClient() {
    return Client.builder()
        .vertexAI(true)
        .project("lo-que-sea")
        .location("global")
        // .apiKey() es mutuamente excluyente con project/location: el token de
        // Axium va como credencial estatica (evita ADC y anade el Bearer).
        .credentials(GoogleCredentials.create(
            new AccessToken("ax_34d7b1add3da3ceb7d67e6035ae75183e29b1911", null)))
        .httpOptions(HttpOptions.builder()
            .baseUrl("https://axium-core.a.run.app/v1/proxy-apps/686f2125-be80-45f6-b559-f96163924c29/vertex")
            .build())
        .build();
  }

  @Bean
  GoogleGenAiChatModel chatModel(Client genAiClient) {
    return GoogleGenAiChatModel.builder()
        .genAiClient(genAiClient)
        .options(GoogleGenAiChatOptions.builder()
            .model("google/gemini-3.5-flash-lite")
            .build())
        .build();
  }

  @Bean
  ApplicationRunner run(GoogleGenAiChatModel chatModel) {
    return args -> System.out.println(
        ChatClient.create(chatModel).prompt("Que modelo eres?").call().content());
  }
}
